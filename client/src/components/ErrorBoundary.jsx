import { Component } from "react";
import { AlertTriangle } from "lucide-react";
import { PrimaryButton } from "./ui";

// Without this, an uncaught render error unwinds all the way to the React
// root (React's default for render-phase exceptions) and unmounts the
// entire tree — including AuthProvider's session state, which lives above
// the routed pages. That's what turned a single page's bug into "the app
// crashed and I got logged out." Catching it here, below AuthProvider,
// keeps the session alive and shows a recoverable screen instead.
export class RouteErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[RouteErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
          <AlertTriangle size={32} className="text-red-500" />
          <div>
            <p className="text-sm font-medium text-gray-900">Something went wrong loading this page.</p>
            <p className="text-xs text-gray-500 mt-1">{this.state.error.message}</p>
          </div>
          <PrimaryButton onClick={() => window.location.assign("/")}>Back to Home</PrimaryButton>
        </div>
      );
    }
    return this.props.children;
  }
}
