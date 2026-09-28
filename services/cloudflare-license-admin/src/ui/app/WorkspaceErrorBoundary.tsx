import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { name: string; active: boolean; children: ReactNode }
interface State { failed: boolean }

/**
 * Contains a render failure to the one feature (or, wrapping the whole shell, the whole console)
 * that threw it. `active` is which tab an operator can currently see: while failed and inactive,
 * this renders `null` rather than the fallback, so a background tab's crash stays silent until the
 * operator actually switches to it, and switching back to a tab that failed retries its render
 * (`componentDidUpdate`) instead of pinning the fallback forever.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // The error's message and the feature's props may carry customer data; only the error's name
    // (a class like "TypeError") and the feature's own identifier are safe to log.
    console.error(JSON.stringify({ event: "admin_ui.render_failed", feature: this.props.name, error: error.name }));
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && !previous.active && this.props.active) this.setState({ failed: false });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (!this.props.active) return null;
    return (
      <div className="activityMessage" data-tone="error" role="alert">
        <p>This page could not be shown. Reload the page to try again; other pages still work.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload the page</button>
      </div>
    );
  }
}
