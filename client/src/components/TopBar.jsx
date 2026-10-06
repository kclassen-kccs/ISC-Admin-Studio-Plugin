import { ChevronLeft, Menu } from "lucide-react";
import { Spinner } from "./ui";
import { useNavDrawer } from "../hooks/useNavDrawer";

export function TopBar({ title, subtitle, onBack, action, loading }) {
  const { setOpen } = useNavDrawer();
  return (
    <div
      className="sticky top-0 z-10 bg-white border-b border-gray-100 px-4 pb-3 flex items-center justify-between gap-3"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {onBack ? (
          <button
            onClick={onBack}
            className="flex items-center gap-0.5 text-blue-600 text-sm font-medium flex-shrink-0 -ml-1"
          >
            <ChevronLeft size={20} />
            Back
          </button>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="md:hidden flex items-center justify-center -ml-1 mr-0.5 text-gray-600 flex-shrink-0"
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
        )}
        <div className="min-w-0">
          {typeof title === "string" ? (
            <h1 className="text-base font-semibold text-gray-900 truncate leading-tight">
              {title}
            </h1>
          ) : (
            title
          )}
          {subtitle && (
            <p className="text-xs text-gray-400 leading-none mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {loading && <Spinner size={16} />}
        {action}
      </div>
    </div>
  );
}
