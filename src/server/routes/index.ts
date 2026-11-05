/**
 * Route registry.
 *
 * Importing this module registers every endpoint. Order matters in one specific
 * way: the matcher walks the registry in registration order, so a literal
 * segment (`kds/metrics`) must be registered before a parameter at the same
 * depth (`kds/:station`) or the literal is swallowed. Each module keeps its own
 * literals ahead of its wildcards.
 *
 * Import order between modules is not significant — no two modules claim the
 * same method + segment shape.
 */
import "./platform";
import "./session";
import "./menu";
import "./floor";
import "./orders";
import "./kitchen";
import "./host";
import "./inventory";
import "./purchasing";
import "./staff";
import "./labor";
import "./reports";
import "./customer";
import "./hardware";
import "./setup";

export {};
