import { motion } from "framer-motion";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { UsopgridLogo, USOPGRID_TAGLINE } from "@/components/brand";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen bg-navy text-ivory flex flex-col"
    >
      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="max-w-5xl mx-auto relative">
          <div className="flex flex-col items-center text-center">
            <UsopgridLogo tone="onDark" />
            <p className="mt-10 font-display text-6xl font-semibold text-ivory">404</p>
            <div className="mt-4 h-px w-16 bg-gold" />
            <h1 className="mt-4 font-sans text-lg font-normal text-[#C6CAD3]">This page doesn't exist. It may have moved.</h1>
            <p className="mt-1 text-sm text-champagne">{USOPGRID_TAGLINE}</p>
            <Button asChild className="mt-8 bg-gold text-midnight hover:bg-champagne">
              <Link to="/">Back to USOPGRID</Link>
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
