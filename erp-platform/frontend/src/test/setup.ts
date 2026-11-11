import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Debounced pickers and mocked network calls can be slow on a busy CI machine; a generous wait avoids false failures.
configure({ asyncUtilTimeout: 4000 });
