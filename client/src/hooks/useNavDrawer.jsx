import { createContext, useContext, useState } from "react";

// Open/closed state for the mobile hamburger nav drawer — lives above the
// router so TopBar (rendered deep inside whichever page is active) can open
// it without every page having to thread a callback down to it.
const NavDrawerContext = createContext(null);

export function NavDrawerProvider({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <NavDrawerContext.Provider value={{ open, setOpen }}>
      {children}
    </NavDrawerContext.Provider>
  );
}

export function useNavDrawer() {
  return useContext(NavDrawerContext);
}
