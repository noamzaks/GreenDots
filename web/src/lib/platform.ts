"use client"

/** The modifier key for shortcuts, as this platform names it: ⌘ on Apple devices, Ctrl elsewhere. */
export const mod = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl")
