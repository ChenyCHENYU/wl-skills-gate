const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  throw new Error(
    "wl-ui-produce must be installed with pnpm. Run: corepack pnpm install"
  );
}

console.log(`Package manager check passed: ${userAgent.split(" ")[0]}.`);
