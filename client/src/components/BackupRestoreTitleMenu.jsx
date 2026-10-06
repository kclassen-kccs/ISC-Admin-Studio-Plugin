import { BACKUP_RESTORE_SUBLINKS } from "./Nav";
import { TitleMenu } from "./TitleMenu";

// Title-as-menu for the Backup & Restore screens (Backup/Restore) — same
// pattern as RoleMiningTitleMenu. Mirrors BACKUP_RESTORE_SUBLINKS so the
// list can't drift from the sidebar's sub-links.
export function BackupRestoreTitleMenu({ active }) {
  return <TitleMenu active={active} items={BACKUP_RESTORE_SUBLINKS} />;
}
