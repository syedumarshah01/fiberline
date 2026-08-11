import React from "react";

/**
 * Error Boundary component to catch and gracefully handle React component errors.
 * Displays a fallback UI when a child component throws an error.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.container}>
          <div style={styles.content}>
            <h2 style={styles.title}>Something went wrong</h2>
            <p style={styles.message}>
              {this.props.fallbackMessage || "An unexpected error occurred."}
            </p>
            {import.meta.env.DEV && this.state.error && (
              <details style={styles.details}>
                <summary style={styles.summary}>Error details</summary>
                <pre style={styles.pre}>{this.state.error.toString()}</pre>
                <pre style={styles.pre}>{this.state.errorInfo?.componentStack}</pre>
              </details>
            )}
            <button style={styles.button} onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "200px",
    padding: "20px",
    backgroundColor: "var(--surface)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
  },
  content: {
    textAlign: "center",
    maxWidth: "400px",
  },
  title: {
    fontSize: "18px",
    fontWeight: "600",
    color: "var(--red)",
    marginBottom: "8px",
  },
  message: {
    fontSize: "14px",
    color: "var(--text-muted)",
    marginBottom: "16px",
  },
  details: {
    textAlign: "left",
    marginBottom: "16px",
    fontSize: "12px",
  },
  summary: {
    cursor: "pointer",
    color: "var(--text-muted)",
    marginBottom: "8px",
  },
  pre: {
    backgroundColor: "var(--surface-raised)",
    padding: "12px",
    borderRadius: "4px",
    overflow: "auto",
    fontSize: "11px",
    color: "var(--text-muted)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  button: {
    padding: "8px 16px",
    backgroundColor: "var(--teal)",
    color: "#08201d",
    border: "none",
    borderRadius: "var(--radius)",
    fontWeight: "500",
    cursor: "pointer",
  },
};

export default ErrorBoundary;
