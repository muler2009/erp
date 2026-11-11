import { BrowserRouter } from "react-router";

import { PlatformApp } from "./features/platform/PlatformApp";
import { useAuth } from "./shared/auth/AuthProvider";
import { TenantApp } from "./routes/TenantApp";

export function App() {
  const { config } = useAuth();
  return <BrowserRouter>{config?.context === "platform" ? <PlatformApp /> : <TenantApp />}</BrowserRouter>;
}
