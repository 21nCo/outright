import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <TooltipProvider><App /></TooltipProvider>,
);
