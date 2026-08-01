import { describe, expect, it } from "vitest";
// @ts-expect-error -- release tooling is plain ESM, outside the typed src/ tree.
import { decidePublish } from "../scripts/publish-guard.mjs";

/**
 * The release workflow fires on both a tag push and `workflow_dispatch`, so the
 * same version reaches `npm publish` twice whenever a release is retried or the
 * two triggers overlap. npm answers the second attempt with
 * "You cannot publish over the previously published versions", which failed
 * three of the first six release runs. The guard turns that collision into a
 * skipped step instead of a red run.
 */
describe("publish guard", () => {
	it("skips a version the registry already serves", () => {
		expect(decidePublish({ status: 200, versions: ["0.2.3", "0.2.4"], version: "0.2.4" })).toMatchObject({
			publish: false,
		});
	});

	it("publishes a version the registry does not have", () => {
		expect(decidePublish({ status: 200, versions: ["0.2.3", "0.2.4"], version: "0.2.5" })).toMatchObject({
			publish: true,
		});
	});

	it("publishes when the package itself is not on the registry yet", () => {
		expect(decidePublish({ status: 404, versions: [], version: "0.1.0" })).toMatchObject({ publish: true });
	});

	/**
	 * The dangerous failure mode is the opposite of a collision: treating an
	 * unreadable registry as "already published" would silently drop a real
	 * release and report success. Anything that is not a definite answer has to
	 * fail the run.
	 */
	it("fails instead of guessing when the registry cannot be read", () => {
		expect(() => decidePublish({ status: 503, versions: [], version: "0.2.5" })).toThrow(/503/);
	});

	it("states the reason so the workflow log explains the decision", () => {
		expect(decidePublish({ status: 200, versions: ["0.2.4"], version: "0.2.4" }).reason).toContain("0.2.4");
	});
});
