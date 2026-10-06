import { STUDIO_SETTINGS_SUBLINKS } from "./Nav";
import { TitleMenu } from "./TitleMenu";

// Title-as-menu for the Studio Settings screens (Scanning Config/
// Evaluation Config) — same pattern as RoleMiningTitleMenu. Mirrors
// STUDIO_SETTINGS_SUBLINKS so the list can't drift from the sidebar's
// sub-links.
export function StudioSettingsTitleMenu({ active }) {
  return <TitleMenu active={active} items={STUDIO_SETTINGS_SUBLINKS} />;
}
