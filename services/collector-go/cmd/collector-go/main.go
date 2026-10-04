// Command collector-go is the single local process that normalizes telemetry, correlates payment
// failure bursts after deployments, and publishes incidents durably. It reads its settings from the
// environment and writes JSON logs to stdout.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"signalforge/collector-go/internal/config"
	"signalforge/collector-go/internal/correlate"
	"signalforge/collector-go/internal/ingest"
	"signalforge/collector-go/internal/publish"
	"signalforge/collector-go/internal/store"
)

const (
	rawTopic        = "telemetry.raw.v1"
	deploymentTopic = "deployments.v1"
	consumerGroup   = "collector-go-normalizer"
	cycleInterval   = time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, logger)
	stop()
	os.Exit(code)
}

// run owns every resource and releases it through defer before it returns the exit status. It returns
// 1 for invalid configuration, a failed migration, or a normalizer failure, and 0 on a signal.
func run(ctx context.Context, logger *slog.Logger) int {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	addr := net.JoinHostPort(cfg.ClickHouseHost, strconv.Itoa(cfg.ClickHousePort))
	ch, err := store.OpenClickHouse(addr, cfg.ClickHouseDatabase, cfg.ClickHouseUser, cfg.ClickHousePassword)
	if err != nil {
		logger.Error("clickhouse open failed", "error", err.Error())
		return 1
	}
	defer ch.Close()

	applied, err := ch.MigrateUpWithCount(ctx)
	if err != nil {
		logger.Error("migrations failed", "error", err.Error())
		return 1
	}
	logger.Info("migrations applied", "applied", applied)

	consumerClient, err := ingest.NewConsumer(cfg.KafkaBrokers, []string{rawTopic, deploymentTopic}, consumerGroup)
	if err != nil {
		logger.Error("kafka consumer failed", "error", err.Error())
		return 1
	}
	defer consumerClient.Close()

	producerClient, err := ingest.NewProducer(cfg.KafkaBrokers)
	if err != nil {
		logger.Error("kafka producer failed", "error", err.Error())
		return 1
	}
	defer producerClient.Close()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	now := func() time.Time { return time.Now().UTC() }
	producer := &ingest.KafkaProducer{Client: producerClient}
	normalizer := &ingest.Normalizer{
		Consumer: &ingest.KafkaConsumer{Client: consumerClient},
		Producer: producer,
		Store:    ch,
		Now:      now,
		Backoff:  ingest.NewBackoff(),
		Log:      logger,
	}
	correlator := &correlate.Correlator{Store: ch, Now: now, Log: logger}
	publisher := &publish.Publisher{
		Store:               ch,
		Producer:            producer,
		Now:                 now,
		FailProduceAttempts: cfg.IncidentPublishFailAttempts,
		CrashAfterProduce:   cfg.IncidentCrashAfterProduce,
		Log:                 logger,
	}

	// A normalizer failure is fatal: it cancels the process context and sets the exit status.
	fatal := make(chan struct{}, 1)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for ctx.Err() == nil {
			if err := normalizer.PollOnce(ctx); err != nil {
				if ctx.Err() != nil {
					return
				}
				logger.Error("cycle failed", "stage", "normalizer", "error", err.Error())
				fatal <- struct{}{}
				cancel()
				return
			}
		}
	}()

	correlatorTicker := time.NewTicker(cycleInterval)
	defer correlatorTicker.Stop()
	publisherTicker := time.NewTicker(cycleInterval)
	defer publisherTicker.Stop()

	wg.Add(2)
	go func() {
		defer wg.Done()
		runCycles(ctx, correlatorTicker.C, "correlator", logger, func(ctx context.Context) error {
			return correlator.RunCycle(ctx, now())
		})
	}()
	go func() {
		defer wg.Done()
		runCycles(ctx, publisherTicker.C, "publisher", logger, publisher.RunCycle)
	}()

	wg.Wait()
	select {
	case <-fatal:
		return 1
	default:
		return 0
	}
}

// runCycles runs cycle on every tick until ticks is closed or ctx is done. A failed cycle is logged
// as "cycle failed" with its stage and does not stop the loop.
func runCycles(ctx context.Context, ticks <-chan time.Time, stage string, logger *slog.Logger, cycle func(context.Context) error) {
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-ticks:
			if !ok {
				return
			}
			if err := cycle(ctx); err != nil {
				if ctx.Err() != nil {
					return // interrupted by shutdown, not a failure
				}
				logger.Error("cycle failed", "stage", stage, "error", err.Error())
			}
		}
	}
}
