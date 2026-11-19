/** Local-network helpers for manager-initiated printer/EMV configuration. */
import { createConnection, isIP } from "node:net";
import { isDemoMode } from "@/lib/session";
import { badRequest, forbidden } from "@/server/router";

export interface TcpCheckResult {
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number;
  message: string;
}

export function validateNetworkHost(value: string): string {
  const host = String(value ?? "").trim();
  if (!host || host.length > 253 || /[\s/\\@]/.test(host) || host.includes(":")) {
    // Bracketless IPv6 literals contain colons; accept those explicitly.
    if (!host || isIP(host) !== 6) throw badRequest("Enter a valid IP address or hostname, without a protocol");
  }
  if (!isIP(host) && !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host)) {
    throw badRequest("Enter a valid IP address or hostname");
  }
  return host;
}

/** A connection check only — no bytes are sent to the device. */
export function checkTcpConnection(hostInput: string, port: number, timeoutMs = 1200): Promise<TcpCheckResult> {
  const host = validateNetworkHost(hostInput);
  // Cloud tenants must not probe the server network or metadata services.
  // Literal IPs avoid DNS rebinding. Permit only operator-approved devices.
  if (!isDemoMode()) {
    const allowed = (process.env.RMS_HARDWARE_ALLOWED_IPS ?? "").split(",").map((ip) => ip.trim());
    if (!isIP(host) || !allowed.includes(host)) throw forbidden("Device address is not in RMS_HARDWARE_ALLOWED_IPS");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("Port must be between 1 and 65535");
  const started = Date.now();
  return new Promise((resolve) => {
    let complete = false;
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean, message: string) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve({ host, port, reachable, latencyMs: Date.now() - started, message });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "TCP connection established"));
    socket.once("timeout", () => finish(false, "Connection timed out"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

/**
 * Discover listeners on the conventional ESC/POS port across one explicit /24.
 * Discovery is deliberately manager-only and bounded to 254 addresses.
 */
export async function discoverEscPos(subnetInput: string, port = 9100): Promise<{
  subnet: string;
  port: number;
  scanned: number;
  devices: TcpCheckResult[];
}> {
  if (!isDemoMode()) throw forbidden("Network discovery is disabled outside demo mode; configure approved devices explicitly");
  const subnet = String(subnetInput ?? "").trim().replace(/\.$/, "");
  const octets = subnet.split(".").map(Number);
  if (octets.length !== 3 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw badRequest("Network range must be the first three IPv4 octets, for example 192.168.1");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("Port must be between 1 and 65535");

  const devices: TcpCheckResult[] = [];
  let nextHost = 1;
  const workers = Array.from({ length: 40 }, async () => {
    while (nextHost <= 254) {
      const last = nextHost;
      nextHost += 1;
      const result = await checkTcpConnection(`${subnet}.${last}`, port, 180);
      if (result.reachable) devices.push(result);
    }
  });
  await Promise.all(workers);
  devices.sort((a, b) => Number(a.host.split(".").pop()) - Number(b.host.split(".").pop()));
  return { subnet, port, scanned: 254, devices: devices.slice(0, 32) };
}
