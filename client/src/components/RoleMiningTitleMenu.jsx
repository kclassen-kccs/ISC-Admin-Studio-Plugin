import { useRoleMiningSublinks } from "./Nav";
import { TitleMenu } from "./TitleMenu";

// Title-as-menu for the Role Mining screens (Roles/Scan for Roles/Role
// Evaluation/Apply in ISC) — same pattern as BrowseTitleMenu. Mirrors
// useRoleMiningSublinks so the list can't drift from the sidebar's sub-links.
export function RoleMiningTitleMenu({ active }) {
  return <TitleMenu active={active} items={useRoleMiningSublinks()} />;
}
