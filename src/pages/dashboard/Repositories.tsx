// GitHub integration page (USOPGRID developer platform).
// Connect a GitHub personal access token (validated live, stored as SHA-256
// hash, shown only as a 4-char hint), browse repositories and branches.
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Github,
  Link2,
  Loader2,
  RefreshCw,
  Unlink,
  AlertTriangle,
  GitBranch,
  Star,
  Lock,
  ExternalLink,
} from "lucide-react";
import { PageHeader } from "@/components/kit";

interface RepoItem {
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  description: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  language: string | null;
  stars: number;
}

export default function Repositories() {
  const githubState = useQuery(api.github.getConnection, {});
  const connection = githubState === undefined ? undefined : githubState.connection;
  const envKeyPresent = githubState !== undefined && githubState.envKeyPresent;
  const listRepos = useAction(api.github.listRepos);
  const listBranches = useAction(api.github.listBranches);
  const connectAction = useAction(api.github.connect);
  const disconnectAction = useMutation(api.github.disconnect);

  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoItem[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [branchRepo, setBranchRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<Array<{ name: string; commitSha: string }> | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);

  const connected =
    connection !== null && connection !== undefined && connection.status === "active";

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await connectAction({ token });
      if (result.ok) {
        setToken("");
        setRepos(null);
      } else {
        setConnectError(result.error ?? "Connection failed.");
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await disconnectAction({});
    setRepos(null);
    setBranches(null);
    setBranchRepo(null);
  }

  async function loadRepos() {
    setLoadingRepos(true);
    setReposError(null);
    try {
      const result = await listRepos({});
      if (result.ok) setRepos(result.repos);
      else setReposError(result.error);
    } catch (err) {
      setReposError(err instanceof Error ? err.message : "Could not load repositories.");
    } finally {
      setLoadingRepos(false);
    }
  }

  async function toggleBranches(fullName: string) {
    if (branchRepo === fullName) {
      setBranchRepo(null);
      setBranches(null);
      return;
    }
    setBranchRepo(fullName);
    setBranches(null);
    setLoadingBranches(true);
    try {
      const result = await listBranches({ repo: fullName });
      setBranches(result.ok ? result.branches : null);
    } finally {
      setLoadingBranches(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Repositories"
        description="Connect GitHub to browse your repositories and branches alongside your USOPGRID integration."
      />

      {connection === undefined ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !connected ? (
        envKeyPresent && (
          <Alert className="mb-4">
            <Github className="size-4" />
            <AlertDescription>
              A platform <span className="font-mono">GITHUB_TOKEN</span> key is configured — repository
              browsing works with it. You can also connect a personal token below for
              account-specific repositories.
            </AlertDescription>
          </Alert>
        )
      ) : !connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="size-4" /> Connect GitHub
            </CardTitle>
            <CardDescription>
              Provide a personal access token with repository read access. The token is verified with
              GitHub immediately and stored only as a SHA-256 hash — it is never displayed again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleConnect} className="max-w-md space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="token">Personal access token</Label>
                <Input
                  id="token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="github_pat_… or ghp_…"
                  required
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Create one at github.com → Settings → Developer settings → Personal access tokens.
                  Fine-grained tokens need <span className="font-mono">Contents: read</span> for the
                  repositories you want to browse.
                </p>
              </div>
              {connectError && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>{connectError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={connecting || token.length < 20} className="w-full">
                {connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Link2 className="mr-2 size-4" />}
                Connect GitHub
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Github className="size-4" /> {connection.accountLogin}
                  <Badge variant="outline" className="ml-1">{connection.accountType}</Badge>
                </CardTitle>
                <CardDescription>
                  Connected account · token ending <span className="font-mono">••••{connection.tokenHint}</span>
                  {connection.lastVerifiedAt
                    ? ` · verified ${new Date(connection.lastVerifiedAt).toLocaleString()}`
                    : ""}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={loadRepos} disabled={loadingRepos}>
                  {loadingRepos ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <RefreshCw className="mr-2 size-3.5" />}
                  Refresh repositories
                </Button>
                <Button size="sm" variant="ghost" onClick={handleDisconnect}>
                  <Unlink className="mr-2 size-3.5" /> Disconnect
                </Button>
              </div>
            </CardHeader>
          </Card>

          {reposError && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription>{reposError}</AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Repositories</CardTitle>
              <CardDescription>Repositories you own or collaborate on, newest activity first.</CardDescription>
            </CardHeader>
            <CardContent>
              {repos === null ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Click “Refresh repositories” to load them.
                </p>
              ) : repos.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No accessible repositories found.</p>
              ) : (
                <ul className="divide-y">
                  {repos.map((repo) => (
                    <li key={repo.fullName} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <a
                              href={repo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-sm font-medium hover:underline"
                            >
                              {repo.fullName}
                              <ExternalLink className="ml-1 inline size-3 text-muted-foreground" />
                            </a>
                            {repo.private ? <Lock className="size-3 text-muted-foreground" /> : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {repo.description ?? "No description"}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          {repo.language && <span>{repo.language}</span>}
                          <span className="inline-flex items-center gap-1">
                            <Star className="size-3" /> {repo.stars}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleBranches(repo.fullName)}
                          >
                            <GitBranch className="mr-1 size-3.5" />
                            {branchRepo === repo.fullName ? "Hide branches" : "Branches"}
                          </Button>
                        </div>
                      </div>
                      {branchRepo === repo.fullName && (
                        <div className="mt-2 rounded-md border bg-muted/40 p-3">
                          {loadingBranches ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          ) : branches && branches.length > 0 ? (
                            <ul className="space-y-1">
                              {branches.slice(0, 12).map((b) => (
                                <li key={b.name} className="flex items-center justify-between text-xs">
                                  <span className="font-mono">{b.name}</span>
                                  <span className="font-mono text-muted-foreground">{b.commitSha.slice(0, 7)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted-foreground">No branches returned.</p>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
