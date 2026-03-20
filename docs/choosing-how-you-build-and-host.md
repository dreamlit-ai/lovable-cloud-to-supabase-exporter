# Choosing how you build and host

You've moved your data to Supabase. Now you get to decide two things: where you _build_ your app (Lovable, Claude Code, Cursor, your own setup) and where it _runs_ for your users (Lovable, Vercel, Netlify, or somewhere else). This guide walks through each combination.

This guide assumes you have a Lovable app and your backend is on Supabase (either from the start, or after running the [exporter tool](/README.md)).

## Choose your path

When you're getting started, Lovable handles both building and hosting in one place. As your app grows, you might want to split those up. Here are four ways to set things up:

| Path       | Where you build                     | Where it runs for users               |
| :--------- | :---------------------------------- | :------------------------------------ |
| **Path 1** | Lovable                             | Lovable                               |
| **Path 2** | Locally (Claude Code, Cursor, etc.) | Lovable                               |
| **Path 3** | Lovable                             | Your own host (Vercel, Netlify, etc.) |
| **Path 4** | Locally                             | Your own host                         |

- **Path 1**: Easiest. Stay on Lovable, just swap the backend. No new tools to learn.
- **Path 2**: Best if you want cheaper/better dev tools but don't want to deal with hosting.
- **Path 3**: Best if you like building in Lovable but want to control where your app runs.
- **Path 4**: Most control, most setup. Best for teams and non-prototype apps.

## Path 1: Stay on Lovable, use Supabase as the backend

The closest experience to staying fully on Lovable, just with your own Supabase project behind it. That gives you direct access to your database for things like [Dreamlit](https://dreamlit.ai), plus the full power of Supabase.

- You still want Lovable for building, previews, and deploying
- You want the least amount of change after the data migration
- You want the flexibility to move to another path later

**Tip:** If you're starting a brand new project, select Supabase as the backend over Lovable Cloud. It'll make it much easier to switch to any of the other paths down the road.

As of now, there's no way to remove Lovable Cloud as the backend in the Lovable UI. You'll need to start a new project, bring in your source code, and connect your Supabase project.

### Steps

- [ ] Create a fresh Supabase project and migrate your Lovable Cloud backend there using [the exporter tool](/README.md).
- [ ] Create a new Lovable project for the Supabase-backed version of the app. Tell Lovable something like `Create an empty project named "<old name> - Supabase backed"`.
- [ ] After the project loads, go to the Cloud tab, click "Already have a Supabase project? Connect it here", and follow the instructions to connect the Supabase project you migrated in the first step.

Now move over the source code:

- [ ] In the **old** Lovable project, click the GitHub icon in the upper right corner to sync the project with GitHub. Select an organization to create a new repo.
- [ ] In the **old** Lovable project, click the GitHub icon, then open the repo in GitHub. Under the Code dropdown, click Download ZIP.
- [ ] Unzip the file locally.
- [ ] In the **new** Lovable project, click the GitHub icon in the upper right corner and sync the project with a new GitHub repo.
- [ ] In the **new** Lovable project, click the GitHub icon and open it in VSCode (it loads in the browser). Delete all files in the file explorer on the left (select all, right-click, Delete Permanently). Then drag the contents of the unzipped folder into the file explorer. You'll see it upload everything.
- [ ] Click the Source Control tab on the left side, enter a commit message, and click Commit & Push.

Lovable may take a few minutes to pick up the latest code and rebuild the project. If needed, prompt Lovable to refresh or reload.

- [ ] Test the full app flow inside Lovable previews before you switch traffic.

### What changes

- Lovable still handles building, previews, deploying, and hosting.
- Your data now lives in your own Supabase project.
- You still get the easiest workflow, but with more control over the backend.

## Path 2: Build locally, deploy through Lovable

The pragmatic split. You get the freedom to build with whatever tools you want, without taking on the complexity of hosting. You work on the same GitHub repo your Lovable app is connected to, just from your own machine. When you're ready to deploy, head into the Lovable UI to preview and publish.

- You want to try different AI coding tools for development
- Lovable costs are adding up and you want a cheaper way to build
- You want flexibility in how you develop without changing how your app is hosted

**Note:** Your app needs to be on a Supabase backend for this to work, not Lovable Cloud. This requires some basic comfort with the terminal.

### Steps

- [ ] If you don't already have Supabase as your backend, create a fresh Supabase project and migrate your Lovable Cloud backend there using [the exporter tool](/README.md). If you're already on Supabase, skip to the next step.
- [ ] In the Lovable project, click the GitHub icon in the upper right corner to sync the project with GitHub. Select an organization to create a new repo.
- [ ] Clone the repo locally.
- [ ] Install your preferred AI coding agent (Claude Code, Codex, or similar).
- [ ] Set up your `.env` and secrets.
- [ ] Use your agent to install dependencies and run the local development server.
- [ ] Build whatever you want locally.
- [ ] When you're ready, commit and push your changes with git.
- [ ] Lovable should automatically pick up the changes. Hit Publish as usual.

## Path 3: Build in Lovable, host your app somewhere else

The middle ground. You keep Lovable's building experience, but your app runs somewhere you control. You build in Lovable and push to GitHub. A hosting platform picks up the changes and deploys your app for users automatically.

- You want more control over where your app runs for users
- You're comfortable with a bit more setup up front
- You want to keep Lovable's building experience

### Steps

- [ ] If you don't already have Supabase as your backend, create a fresh Supabase project and migrate your Lovable Cloud backend there using [the exporter tool](/README.md). If you're already on Supabase, skip to the next step.
- [ ] In the Lovable project, click the GitHub icon in the upper right corner to sync the project with GitHub. Select an organization to create a new repo.
- [ ] Choose a host for your app. Common options are Vercel, Netlify, Cloudflare Pages, AWS Amplify, or Firebase Hosting.
- [ ] Connect the GitHub repo to that host (details vary by provider).
- [ ] Configure the build settings for your app, including env vars. Copy what you see in your Lovable app to ensure parity. See the [appendix](#appendix-required-env-vars) for the specific variables you'll need.

### What changes

- Lovable still handles building and previews.
- Your app runs on the hosting platform you chose.
- You're now responsible for making sure deploys go smoothly.

## Path 4: Fully self-managed

The most advanced option, and how larger teams typically work. Full control over everything, but you're responsible for everything too. This combines Paths 2 and 3. You build locally, push to Git, and deploy from there. Lovable no longer needs to be in the loop.

- You want full control over both building and hosting
- Lovable costs are adding up and you want to use tools like Claude Code or Cursor locally
- You have multiple teammates and want everyone working independently
- You don't mind the extra effort and technical setup

### Steps

- [ ] If you don't already have Supabase as your backend, create a fresh Supabase project and migrate your Lovable Cloud backend there using [the exporter tool](/README.md). If you're already on Supabase, skip to the next step.
- [ ] In the Lovable project, click the GitHub icon in the upper right corner to sync the project with GitHub. Select an organization to create a new repo.

From there, combine the steps from Path 2 (local development) and Path 3 (hosting your app).

### What changes

- Lovable is no longer required for building or hosting.
- You manage your own development setup, deploys, and hosting.
- This gives you the most control, but also the most responsibility.

## Before you go live

After you finish the steps for your path, make sure everything is working:

- [ ] Your app loads without errors.
- [ ] Users can sign in and sign up.
- [ ] File uploads and downloads work.
- [ ] If you moved hosting (Paths 3 or 4): OAuth redirects point to the right domain, and your env vars match the new Supabase backend.

## Appendix: required env vars

If you're hosting your app outside Lovable (Paths 3 or 4), make sure your hosting platform has these env vars set:

- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`

Copy the values from your Lovable app to ensure they match.

## Appendix: terminology and technical context

**Development vs production.** "Development" is where you build, prompt, preview, and iterate on your app. "Production" is where the live app runs for real users. When you're starting out on Lovable, both happen in the same place. As your app grows, you might want to separate them.

**Shared backend.** All four paths in this guide use a single Supabase backend for both building and running your app. Using a separate backend for production is good practice for larger apps, but it requires additional setup and isn't covered here.

**"Locally" and "your own host."** Building locally means working on your own machine with tools like Claude Code, Cursor, Codex, or your own editor. It requires some basic comfort with the terminal. Hosting on your own means using a platform like Vercel, Netlify, Cloudflare Pages, AWS Amplify, or Firebase Hosting instead of Lovable's built-in hosting.
