import { useBrowseSublinks } from "./Nav";
import { TitleMenu } from "./TitleMenu";

// Title-as-menu for the Browse screens (Identities/Roles/Access
// Profiles/Sources/Data Segments) — lets you jump between them without
// dropping back to the tab bar. Uses the same dynamic list the sidebar's
// sub-links do, so Data Segments shows/hides consistently in both places.
export function BrowseTitleMenu({ active }) {
  const items = useBrowseSublinks();
  return <TitleMenu active={active} items={items} />;
}
