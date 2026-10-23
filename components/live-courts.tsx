import type { Account } from "@/lib/auth";
import RecordingPanel from "./recording-panel";
import { Video } from "lucide-react";

export default async function LiveCourts({
  account,
  problem,
}: {
  account: Account | null;
  problem?: string;
}) {
  if (!account)
    return (
      <div className="empty-panel">
        <Video size={28} />
        <h3>Your court is waiting.</h3>
        <p>
          {problem ||
            "Sign in with your player account to view the venue’s courts."}
        </p>
        <a className="primary" href="/login">
          Sign in to choose a court →
        </a>
        <a className="auth-switch" href="/preview">
          Explore the interface preview
        </a>
      </div>
    );
  return <RecordingPanel email={account.email} />;
}
