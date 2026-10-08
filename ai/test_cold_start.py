"""Offline diagnostic tests; fake Llama only, no model imports or inference."""
import unittest
from check_cold_start import measure_two_queries, QUERIES


class ColdStartDiagnosticTests(unittest.TestCase):
    def test_one_instance_two_calls_then_close_with_separate_load_timer(self):
        events = []
        config = {"system_prompt": "same system prefix"}
        grammar = object()

        class FakeLlama:
            def __init__(self, **settings):
                events.append(("load", settings))

            def create_chat_completion(self, **request):
                events.append(("query", request))
                return {"choices": [{"message": {"content": '{"tool":"lookupDocs","args":{"query":"test"}}'}}]}

            def close(self):
                events.append(("close", None))

        ticks = iter([0, 5, 5, 31.3, 31.3, 35.27])
        report = measure_two_queries(FakeLlama, grammar, config, "fixture.gguf", clock=lambda: next(ticks))
        self.assertEqual([event[0] for event in events], ["load", "query", "query", "close"])
        self.assertNotIn("n_threads", events[0][1])
        self.assertEqual(report["model_load_s"], 5)
        self.assertEqual(report["first_inference_s"], 26.3)
        self.assertEqual(report["second_inference_s"], 3.97)
        for event, query in zip(events[1:3], QUERIES):
            request = event[1]
            self.assertIs(request["grammar"], grammar)
            self.assertEqual(request["messages"][0]["content"], config["system_prompt"])
            self.assertEqual(request["messages"][1]["content"], query)
            self.assertEqual(request["max_tokens"], 200)
            self.assertEqual(request["temperature"], 0.0)

    def test_inference_failure_releases_model_and_does_not_become_a_timing(self):
        events = []

        class FakeLlama:
            def __init__(self, **settings):
                self.settings = settings
                events.append(settings["n_threads"])

            def create_chat_completion(self, **request):
                raise RuntimeError("inference failed")

            def close(self):
                events.append("closed")

        with self.assertRaisesRegex(RuntimeError, "inference failed"):
            measure_two_queries(FakeLlama, None, {"system_prompt": "test"}, "fixture.gguf", threads=4)
        self.assertEqual(events, [4, "closed"])


if __name__ == "__main__":
    unittest.main()
