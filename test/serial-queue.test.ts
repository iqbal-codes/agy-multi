import { describe, expect, test } from "bun:test";
import { SerialQueue } from "../src/serial-queue";

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("serial queue", () => {
	test("never runs two probes at once, whatever the order they arrive", async () => {
		const queue = new SerialQueue();
		let active = 0;
		let peak = 0;
		const order: string[] = [];
		await Promise.all(
			["a", "b", "c", "d"].map(key =>
				queue.run(key, async () => {
					active += 1;
					peak = Math.max(peak, active);
					order.push(key);
					await tick(10);
					active -= 1;
				}),
			),
		);
		expect(peak).toBe(1);
		expect(order).toEqual(["a", "b", "c", "d"]);
	});

	test("a second request for a running key joins the same probe", async () => {
		const queue = new SerialQueue();
		let runs = 0;
		const task = async () => {
			runs += 1;
			await tick(10);
			return runs;
		};
		const first = queue.run("usage:a", task);
		const second = queue.run("usage:a", task);
		expect(second).toBe(first);
		expect(await Promise.all([first, second])).toEqual([1, 1]);
		expect(runs).toBe(1);
	});

	test("spacing keeps consecutive probes apart", async () => {
		const queue = new SerialQueue({ spacingMs: 25 });
		const stamps: number[] = [];
		await Promise.all(
			["a", "b"].map(key =>
				queue.run(key, async () => {
					stamps.push(Date.now());
				}),
			),
		);
		expect(stamps).toHaveLength(2);
		expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(20);
	});

	test("a failing probe does not stall the queue", async () => {
		const queue = new SerialQueue();
		await expect(
			queue.run("boom", async () => {
				throw new Error("probe failed");
			}),
		).rejects.toThrow("probe failed");
		const result = await queue.run("after", async () => "ok");
		expect(result).toBe("ok");
		expect(queue.size).toBe(0);
	});

	test("drain waits for everything queued so far", async () => {
		const queue = new SerialQueue();
		let done = 0;
		void queue.run("a", async () => {
			await tick(15);
			done += 1;
		});
		void queue.run("b", async () => {
			await tick(5);
			done += 1;
		});
		await queue.drain();
		expect(done).toBe(2);
	});
});
