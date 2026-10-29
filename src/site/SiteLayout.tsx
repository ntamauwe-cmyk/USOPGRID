import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { UsopgridMark, USOPGRID_COMPANY } from "@/components/brand";
import "./site.css";

const NAV = [
  { to: "/platform", label: "Platform" },
  { to: "/orchestration", label: "Orchestration" },
  { to: "/integrations", label: "Integrations" },
  { to: "/developers", label: "Developers" },
  { to: "/enterprise", label: "Enterprise" },
  { to: "/security", label: "Security" },
];

export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    document.title = title === "USOPGRID" ? "USOPGRID — Enterprise Payment Infrastructure" : `${title} | USOPGRID`;
    if (description) {
      let m = document.querySelector('meta[name="description"]');
      if (!m) {
        m = document.createElement("meta");
        m.setAttribute("name", "description");
        document.head.appendChild(m);
      }
      m.setAttribute("content", description);
    }
  }, [title, description]);
}

export function SiteLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);

  return (
    <div className="ug">
      <header className="ug-header">
        <div className="ug-wrap ug-header-in">
          <Link to="/" className="ug-brand" aria-label="USOPGRID home">
            <UsopgridMark className="ug-brand-mark" tone="onDark" />
            <span className="ug-brand-word">USOPGRID</span>
          </Link>
          <nav className="ug-nav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ug-header-cta">
            <Link to="/auth" className="ug-btn ug-btn-quiet ug-btn-sm" style={{ color: "#fff" }}>
              Sign in
            </Link>
            <Link to="/contact" className="ug-btn ug-btn-signal ug-btn-sm">
              Contact sales
            </Link>
          </div>
          <button className="ug-menu-btn" aria-expanded={open} aria-controls="ug-mobile-nav" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Menu"}
          </button>
        </div>
        <nav id="ug-mobile-nav" className={`ug-mobile-nav ${open ? "open" : ""}`} aria-label="Mobile">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to}>
              {n.label}
            </Link>
          ))}
          <Link to="/status">System status</Link>
          <Link to="/contact">Contact sales</Link>
          <Link to="/auth">Sign in</Link>
        </nav>
      </header>
      <main id="main">{children}</main>
      <footer className="ug-footer">
        <div className="ug-wrap">
          <div className="ug-foot-grid">
            <div>
              <Link to="/" className="ug-brand" aria-label="USOPGRID home">
                <UsopgridMark className="ug-brand-mark" tone="onDark" />
                <span className="ug-brand-word">USOPGRID</span>
              </Link>
              <p style={{ marginTop: 14, maxWidth: "32ch" }}>Powering Every Payment Connection.</p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li><Link to="/platform">Platform</Link></li>
                <li><Link to="/orchestration">Payment orchestration</Link></li>
                <li><Link to="/integrations">Integrations</Link></li>
                <li><Link to="/enterprise">Enterprise</Link></li>
              </ul>
            </div>
            <div>
              <h4>Developers</h4>
              <ul>
                <li><Link to="/developers">Documentation</Link></li>
                <li><Link to="/developers#api-reference">API reference</Link></li>
                <li><Link to="/developers#sandbox">Sandbox</Link></li>
                <li><Link to="/status">System status</Link></li>
              </ul>
            </div>
            <div>
              <h4>Company</h4>
              <ul>
                <li><Link to="/security">Security</Link></li>
                <li><Link to="/contact">Contact</Link></li>
              </ul>
            </div>
            <div>
              <h4>Legal</h4>
              <ul>
                <li><Link to="/privacy">Privacy</Link></li>
                <li><Link to="/terms">Terms</Link></li>
                <li><Link to="/disclosures">Disclosures</Link></li>
              </ul>
            </div>
          </div>
          <div className="ug-foot-legal">
            <p>
              USOPGRID is a product of {USOPGRID_COMPANY}. USOPGRID provides payment technology; funds are processed and held by the licensed
              payment providers and financial institutions you connect. See <Link to="/disclosures">disclosures</Link>.
            </p>
            <p>© {new Date().getFullYear()} {USOPGRID_COMPANY}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
