import { Component, type ErrorInfo, type ReactNode } from "react";

// Crash-path i18n: the boundary must not depend on React context (the provider itself
// may be inside the crashed subtree), so it reads the persisted language directly.
// Keep these three strings in sync with lib/i18n.tsx's register.
function boundaryText() {
  let he = false;
  try {
    he = localStorage.getItem("shift-scheduler:lang") === "he";
  } catch { /* storage unavailable → English */ }
  return he
    ? { title: "משהו השתבש בעת הצגת התצוגה הזו.", retry: "ניסיון חוזר", reload: "רענון הדף" }
    : { title: "Something went wrong rendering this view.", retry: "Try again", reload: "Reload page" };
}

// A render crash anywhere below this boundary used to blank the whole page (React
// unmounts the tree when an error escapes render), forcing a full page refresh to
// recover. This catches it and shows a recoverable fallback instead — "Try again"
// re-mounts the subtree (enough once the draft/Save editor stops invalid requirements
// reaching render), and "Reload" is the last resort. See HANDOFF Round 2, tweak #1.

interface Props {
  children: ReactNode;
  /** Bump this (e.g. on a committed requirements change) to auto-clear a prior crash. */
  resetKey?: unknown;
}
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A new committed requirements doc (resetKey changed) means the state that crashed
    // is gone — clear the boundary so the user sees the fresh render, not a stale crash.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for debugging without taking the page down.
    console.error("[ErrorBoundary] render crash:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const txt = boundaryText();
      return (
        <div className="fatal" role="alert" data-testid="error-boundary">
          <div className="fatal__box">
            <strong>{txt.title}</strong>
            <p className="fatal__msg">{this.state.error.message}</p>
            <div className="fatal__actions">
              <button className="btn btn--primary" data-testid="error-retry"
                onClick={() => this.setState({ error: null })}>{txt.retry}</button>
              <button className="btn" data-testid="error-reload"
                onClick={() => window.location.reload()}>{txt.reload}</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
