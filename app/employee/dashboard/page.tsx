"use client";

import FigmaDashboard from "@/components/FigmaDashboard";

// Figma Make redesign, wired to real data — replaces the old
// ExecutiveDashboard-based page. See FIGMA_DASHBOARD_BACKEND_MAPPING.md for
// how each panel maps back to skills/*.py. FigmaDashboard owns its own
// top bar (with the Employee/Executive mode toggle) and full-height layout,
// so it renders standalone here rather than inside TopBar/max-w wrappers.
export default function ExecutiveDashboardPage() {
  return <FigmaDashboard />;
}
