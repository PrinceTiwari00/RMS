/** Manager-only local hardware discovery and connectivity checks. */
import { route } from "@/server/router";
import { int, required, str } from "@/server/coerce";
import { checkTcpConnection, discoverEscPos } from "@/server/hardware";

route("POST", "settings/hardware/check", "admin.settings", async ({ body }) => ({
  result: await checkTcpConnection(required(body, "host", "Device address"), int(body, "port", 9100)),
}));

route("POST", "settings/hardware/discover", "admin.settings", async ({ body }) =>
  discoverEscPos(str(body, "subnet", "192.168.1"), int(body, "port", 9100)),
);
