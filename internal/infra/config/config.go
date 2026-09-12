package config

import "os"

type Config struct {
	HTTPAddr    string
	DatabaseURL string
	LogLevel    string
}

func Load() Config {
	return Config{
		HTTPAddr:    envOrDefault("HTTP_ADDR", ":8080"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		LogLevel:    envOrDefault("LOG_LEVEL", "info"),
	}
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
