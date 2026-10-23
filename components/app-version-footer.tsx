import packageDetails from "@/package.json";

export default function AppVersionFooter() {
  return (
    <footer className="shell app-version-footer" aria-label="Application version">
      <strong>Powered by Wren Labs PH</strong>
      <small>Web version {packageDetails.version}</small>
    </footer>
  );
}
