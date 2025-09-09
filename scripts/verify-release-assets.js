#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

/**
 * Verifies that all expected binary assets are present in the GitHub release
 * for the version specified in package.json
 */
async function verifyReleaseAssets() {
  try {
    // Read version from package.json
    const packagePath = path.join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const version = packageJson.version;

    console.log(`🔍 Verifying release assets for version ${version}...`);

    // GitHub API configuration
    const owner = "ternarystudio";
    const repo = "ternary";
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is required");
    }

    // Fetch all releases (including drafts)
    const tagName = `v${version}`;

    console.log(`📡 Fetching all releases to find: ${tagName}`);

    const allReleasesUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;
    const response = await fetch(allReleasesUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ternary-release-verifier",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`,
      );
    }

    const allReleases = await response.json();
    const release = allReleases.find((r) => r.tag_name === tagName);

    if (!release) {
      throw new Error(
        `Release ${tagName} not found in published releases or drafts. Make sure the release exists.`,
      );
    }

    const assets = release.assets || [];

    console.log(`📦 Found ${assets.length} assets in release ${tagName}`);
    console.log(`📄 Release status: ${release.draft ? "DRAFT" : "PUBLISHED"}`);

    // Handle different beta naming conventions across platforms
    const normalizeVersionForPlatform = (version, platform) => {
      // Normalize prerelease identifiers for different packaging ecosystems.
      // Examples:
      //  - RPM/DEB: 1.0.0-beta.1 => 1.0.0.beta.1, 1.0.0-stable.1 => 1.0.0.stable.1
      //  - NuGet:   1.0.0-beta.1 => 1.0.0-beta1,  1.0.0-stable.1 => 1.0.0-stable1
      //  - Others:  keep original (hyphenated) form
      const prereleasePattern = /-(alpha|beta|rc|stable)\.(\d+)/i;

      if (!prereleasePattern.test(version)) {
        return version;
      }

      switch (platform) {
        case "rpm":
          // RPM uses dots: 1.0.0-stable.1 => 1.0.0.stable.1
          return version.replace(prereleasePattern, ".$1.$2");
        case "deb":
          // DEB keeps the original hyphenated form
          return version;
        case "nupkg":
          // NuGet collapses the dot: 1.0.0-stable.1 => 1.0.0-stable1
          return version.replace(prereleasePattern, "-$1$2");
        default:
          // Windows installer and macOS zips keep original format
          return version;
      }
    };

    // Define expected assets with platform-specific version handling
    const expectedAssets = [
      `ternary-${normalizeVersionForPlatform(version, "rpm")}-1.x86_64.rpm`,
      `ternary-${normalizeVersionForPlatform(version, "nupkg")}-full.nupkg`,
      `ternary-${version}.Setup.exe`,
      `ternary-darwin-arm64-${version}.zip`,
      `ternary-darwin-x64-${version}.zip`,
      `ternary_${normalizeVersionForPlatform(version, "deb")}_amd64.deb`,
      "RELEASES",
    ];

    console.log("📋 Expected assets:");
    expectedAssets.forEach((asset) => console.log(`  - ${asset}`));
    console.log("");

    // Get actual asset names
    const actualAssets = assets.map((asset) => asset.name);

    console.log("📋 Actual assets:");
    actualAssets.forEach((asset) => console.log(`  - ${asset}`));
    console.log("");

    // Check for missing assets
    const missingAssets = expectedAssets.filter(
      (expected) => !actualAssets.includes(expected),
    );

    if (missingAssets.length > 0) {
      console.error("❌ VERIFICATION FAILED!");
      console.error("📭 Missing assets:");
      missingAssets.forEach((asset) => console.error(`  - ${asset}`));
      console.error("");
      console.error(
        "Please ensure all platforms have completed their builds and uploads.",
      );
      process.exit(1);
    }

    // Check for unexpected assets (optional warning)
    const unexpectedAssets = actualAssets.filter(
      (actual) => !expectedAssets.includes(actual),
    );

    if (unexpectedAssets.length > 0) {
      console.warn("⚠️  Unexpected assets found:");
      unexpectedAssets.forEach((asset) => console.warn(`  - ${asset}`));
      console.warn("");
    }

    console.log("✅ VERIFICATION PASSED!");
    console.log(
      `🎉 All ${expectedAssets.length} expected assets are present in release ${tagName}`,
    );
    console.log("");
    console.log("📊 Release Summary:");
    console.log(`  Release: ${release.name || tagName}`);
    console.log(`  Tag: ${release.tag_name}`);
    console.log(`  Published: ${release.published_at}`);
    console.log(`  URL: ${release.html_url}`);
  } catch (error) {
    console.error("❌ Error verifying release assets:", error.message);
    process.exit(1);
  }
}

// Run the verification
verifyReleaseAssets();
