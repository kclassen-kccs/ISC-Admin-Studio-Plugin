import { TOOLS_SUBLINKS } from "./Nav";
import { TitleMenu } from "./TitleMenu";

// Title-as-menu for the Tools screens — same pattern as BrowseTitleMenu /
// RoleMiningTitleMenu, sourced from the same list as the sidebar so the
// two can't drift.
export function ToolsTitleMenu({ active }) {
  return <TitleMenu active={active} items={TOOLS_SUBLINKS} />;
}
