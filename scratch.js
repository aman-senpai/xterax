function shortenPath(p) {
  if (!p) return "";
  return p.split(/[/\\]/).pop() || p;
}
console.log(shortenPath("/Users/senpai/Developer/testing/01-introduction-to-ai-agents.md"));
