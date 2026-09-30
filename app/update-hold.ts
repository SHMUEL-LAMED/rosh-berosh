import { useEffect } from "react";

/* מה שטעינה מחדש אוטומטית (AutoUpdate) אסור לה לקטוע: העלאה, שמירה שבדרך, עריכה שלא נשמרה.
   כל מי שמחזיק מקבל פונקציה לשחרור; העדכון מחכה עד שאין אף אחד. */
const holds = new Set<symbol>();

export function holdUpdate(): () => void {
  const token = Symbol("hold");
  holds.add(token);
  return () => { holds.delete(token); };
}

export const updateHeld = () => holds.size > 0;

/** מחזיק את העדכון כל עוד active אמת */
export function useHoldUpdate(active: boolean) {
  useEffect(() => (active ? holdUpdate() : undefined), [active]);
}
