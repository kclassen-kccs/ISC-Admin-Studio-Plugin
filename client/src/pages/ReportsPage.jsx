import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import { listMyReports, getReportBlob } from "../lib/sailpoint";
import { openBlobUrlOrDownload } from "../lib/pdfUtils";
import { TopBar } from "../components/TopBar";
import { SkeletonList, EmptyState, ErrorBox, ListRow, Spinner } from "../components/ui";

// Opens a saved report's PDF as a blob: the route requires the x-sp-session
// header, which a plain <a href>/window.open(url) can't send — same
// popup-blocker fallback (download instead) used by every client-generated
// PDF elsewhere in the app.
async function openReportPdf(id, filename) {
  const blob = await getReportBlob(id);
  const blobUrl = URL.createObjectURL(blob);
  if (!openBlobUrlOrDownload(blobUrl, filename || "report.pdf")) {
    toast("Pop-up blocked — downloaded the PDF instead");
  }
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const [openingId, setOpeningId] = useState(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["my-reports"], queryFn: listMyReports });
  // Newest first — a "my reports" list reads by recency, not by name.
  const list = (Array.isArray(data) ? data : []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  async function handleOpen(r) {
    setOpeningId(r.id);
    try {
      await openReportPdf(r.id, r.filename);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="My Reports" onBack={() => navigate(-1)} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={FileText}
            title="No saved reports"
            subtitle="Reports you generate, like a Roles list Email Report, will appear here."
          />
        )}
        {list.map((r) => (
          <ListRow
            key={r.id}
            left={
              <div className="w-10 h-10 rounded-full bg-purple-50 flex items-center justify-center flex-shrink-0">
                <FileText size={16} className="text-purple-600" />
              </div>
            }
            title={r.title || r.filename}
            subtitle={new Date(r.createdAt).toLocaleString()}
            onClick={() => handleOpen(r)}
            right={openingId === r.id ? <Spinner size={16} /> : <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />}
          />
        ))}
      </div>
    </div>
  );
}
