// Site tests must not depend on the runner's environment: a set UMAMI_* makes every build need the Umami script.
delete process.env.UMAMI_SCRIPT_URL;
delete process.env.UMAMI_WEBSITE_ID;
