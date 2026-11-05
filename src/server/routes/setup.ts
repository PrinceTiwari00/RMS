/** Token-protected, one-time production initialization. */
import { created, publicRoute } from "@/server/router";
import { initializeProduction, productionSetupStatus } from "@/server/bootstrap";
import { optStr, required } from "@/server/coerce";

publicRoute("GET", "setup/status", () => productionSetupStatus());

publicRoute("POST", "setup/initialize", ({ body }) =>
  created(
    initializeProduction({
      setupToken: required(body, "setupToken", "Setup token"),
      restaurantName: required(body, "restaurantName", "Restaurant name"),
      tagline: optStr(body, "tagline"),
      adminName: required(body, "adminName", "Manager name"),
      adminPin: required(body, "adminPin", "Manager PIN"),
    }),
  ),
);
