/** The live sender asks frame-doctor to load the current run. Doctor owns the listener; pledge.ts holds the run itself. */
const OPEN = "altpool:open-in-doctor";

export const openInDoctor = () => {
  window.dispatchEvent(new Event(OPEN));
  document.getElementById("doctor")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
};

export const onOpenInDoctor = (fn: () => void) => {
  window.addEventListener(OPEN, fn);
  return () => window.removeEventListener(OPEN, fn);
};
