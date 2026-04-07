import React from "react"
import { AnimatePresence, motion } from "framer-motion"

type OnboardingSpotlightProps = {
  isActive: boolean
  targetRect: DOMRect | null
  padding?: number
  borderRadius?: number
}

const OnboardingSpotlight: React.FC<OnboardingSpotlightProps> = ({
  isActive,
  targetRect,
  padding = 12,
  borderRadius = 16
}) => {
  const hole = targetRect
    ? {
        top: Math.max(0, targetRect.top - padding),
        left: Math.max(0, targetRect.left - padding),
        width: targetRect.width + padding * 2,
        height: targetRect.height + padding * 2
      }
    : null

  return (
    <AnimatePresence>
      {isActive && hole && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[75]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          <div
            className="absolute left-0 right-0 top-0 bg-black/60"
            style={{ height: hole.top }}
          />
          <div
            className="absolute bg-black/60"
            style={{
              top: hole.top,
              left: 0,
              width: hole.left,
              height: hole.height
            }}
          />
          <div
            className="absolute bg-black/60"
            style={{
              top: hole.top,
              left: hole.left + hole.width,
              right: 0,
              height: hole.height
            }}
          />
          <div
            className="absolute left-0 right-0 bottom-0 bg-black/60"
            style={{ top: hole.top + hole.height }}
          />

          <motion.div
            className="absolute border border-[#8DB6FF]/65"
            style={{
              top: hole.top,
              left: hole.left,
              width: hole.width,
              height: hole.height,
              borderRadius,
              boxShadow: "0 0 0 2px rgba(141, 182, 255, 0.22), 0 0 28px rgba(122, 168, 255, 0.38)"
            }}
            initial={{ scale: 0.98, opacity: 0.85 }}
            animate={{ scale: [1, 1.03, 1], opacity: [0.88, 1, 0.9] }}
            transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default OnboardingSpotlight