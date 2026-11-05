/** Core RBAC/station records shared by demo seeding and production setup. */
import { run, uuid } from "@/db/client";
import { ROLE_DEFINITIONS, type Permission } from "@/domain/permissions";
import { DEFAULT_STATIONS } from "@/domain/kds";
import { nowStamp } from "@/domain/time";

export function seedCoreRoles(): Map<string, string> {
  const ids = new Map<string, string>();
  ROLE_DEFINITIONS.forEach((definition, index) => {
    const id = uuid();
    ids.set(definition.name, id);
    run(
      "INSERT INTO roles (id, name, title, hourly_rate, is_system, sort_order) VALUES (?, ?, ?, ?, 1, ?)",
      id,
      definition.name,
      definition.title,
      definition.hourlyRate,
      index,
    );
    for (const permission of definition.permissions as Permission[]) {
      run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)", id, permission);
    }
  });
  return ids;
}

export function seedCoreStations(): void {
  run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('stations', ?, ?)",
    JSON.stringify(DEFAULT_STATIONS),
    nowStamp(),
  );
}
