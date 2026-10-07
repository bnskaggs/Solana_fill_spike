import { watchGraduations } from "../graduations";

console.log("Watching PumpSwap graduations. Ctrl+C to stop.");

let stop: (() => Promise<void>) | undefined;
try {
  stop = watchGraduations((event) => {
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(event.graduatedAt)) / 1000));
    console.log(
      `${event.graduatedAt} age=${age}s mint=${event.mint} pool=${event.pool} slot=${event.slot} sig=${event.signature}`,
    );
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

process.on("SIGINT", async () => {
  if (stop) await stop();
  process.exit(0);
});

