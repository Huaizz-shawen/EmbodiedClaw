import type { OpenClawPluginApi } from "../plugin-api.js";
import { distillEpisodes, getLearningStoreStats } from "../learning/episode-store.js";

/**
 * Register the /distill command.
 * Distills collected tool episodes into a failure library + markdown report.
 */
export function registerDistillCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "distill",
    description: "Distill RosClaw episode traces into failure patterns and a summary report",

    async handler(_ctx) {
      try {
        const stats = await getLearningStoreStats();
        const { summary, reportPath, failureLibraryPath } = await distillEpisodes();

        return {
          text:
            [
              "Distillation completed.",
              `Learning root: ${stats.root ?? "(not initialized)"}`,
              `Episodes bytes: ${stats.episodesBytes}`,
              `Total episodes: ${summary.totalEpisodes}`,
              `Success: ${summary.successCount}`,
              `Errors: ${summary.errorCount}`,
              `Failure library: ${failureLibraryPath}`,
              `Report: ${reportPath}`,
            ].join("\n"),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`Distillation failed: ${message}`);
        return { text: `Distillation failed: ${message}` };
      }
    },
  });
}
