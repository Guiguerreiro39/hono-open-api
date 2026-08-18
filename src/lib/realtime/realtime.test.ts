import { describe, expect, it, vi } from "vitest";
import { PubSubManager } from "./pubsub";

describe("PubSubManager", () => {
  it("subscribes and receives published events", () => {
    const ps = new PubSubManager();
    const listener = vi.fn();

    const unsub = ps.subscribe("tasks:user1", listener);

    ps.publish("tasks:user1", { action: "create", data: { id: 1, name: "Task 1" } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create",
        data: { id: 1, name: "Task 1" },
      }),
    );

    unsub();
    ps.publish("tasks:user1", { action: "update", data: { id: 1, name: "Task 1 Updated" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates topics from each other", () => {
    const ps = new PubSubManager();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    ps.subscribe("topic1", listener1);
    ps.subscribe("topic2", listener2);

    ps.publish("topic1", { action: "test" });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).not.toHaveBeenCalled();
  });
});
