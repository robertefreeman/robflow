import unittest

from unittest.mock import patch

from robflow_worker_adk import InferenceConfig, WorkerConfig, create_config, create_inference_config


class WorkerImportTest(unittest.TestCase):
    def test_create_config_returns_worker_config(self) -> None:
        self.assertIsInstance(create_config(), WorkerConfig)

    def test_create_inference_config_reads_env_contract(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "ROBFLOW_INFERENCE_BASE_URL": "https://llm.example/v1",
                "ROBFLOW_INFERENCE_API_KEY": "test-key",
                "ROBFLOW_INFERENCE_DEFAULT_MODEL": "demo-model",
                "ROBFLOW_INFERENCE_HEADERS_JSON": '{"X-Test":"yes"}',
                "ROBFLOW_INFERENCE_TIMEOUT_SECONDS": "12.5",
                "ROBFLOW_INFERENCE_MAX_RETRIES": "4",
            },
        ):
            config = create_inference_config()

        self.assertIsInstance(config, InferenceConfig)
        self.assertEqual(config.base_url, "https://llm.example/v1")
        self.assertEqual(config.headers, {"X-Test": "yes"})
        self.assertEqual(config.timeout_seconds, 12.5)
        self.assertEqual(config.max_retries, 4)


if __name__ == "__main__":
    unittest.main()
