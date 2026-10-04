package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// Record is one message consumed from Kafka: its source position and raw value.
type Record struct {
	Topic     string
	Partition int32
	Offset    int64
	Value     []byte
}

// Consumer is the source of records. Commit moves the group position past the given records.
type Consumer interface {
	Poll(ctx context.Context) ([]Record, error)
	Commit(ctx context.Context, records []Record) error
}

// Producer writes one message and returns only after it is acknowledged.
type Producer interface {
	Produce(ctx context.Context, topic, key string, value []byte) error
}

var (
	_ Consumer = (*KafkaConsumer)(nil)
	_ Producer = (*KafkaProducer)(nil)
)

// NewConsumer returns a consumer-group client. Auto-commit is disabled: offsets move only through
// KafkaConsumer.Commit, after the batch has been persisted or dead-lettered.
func NewConsumer(brokers []string, topics []string, group string) (*kgo.Client, error) {
	return kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ConsumeTopics(topics...),
		kgo.ConsumerGroup(group),
		kgo.DisableAutoCommit(),
		kgo.FetchMaxWait(time.Second),
	)
}

// NewProducer returns a client used to produce dead letters.
func NewProducer(brokers []string) (*kgo.Client, error) {
	return kgo.NewClient(kgo.SeedBrokers(brokers...))
}

// KafkaConsumer adapts a consumer-group client to the Consumer interface.
type KafkaConsumer struct {
	Client *kgo.Client
}

// Poll fetches up to one second of records. A fetch error is returned with no records.
func (k *KafkaConsumer) Poll(ctx context.Context) ([]Record, error) {
	fetches := k.Client.PollFetches(ctx)
	if errs := fetches.Errors(); len(errs) > 0 {
		return nil, fmt.Errorf("poll %s/%d: %w", errs[0].Topic, errs[0].Partition, errs[0].Err)
	}
	var out []Record
	fetches.EachRecord(func(r *kgo.Record) {
		out = append(out, Record{Topic: r.Topic, Partition: r.Partition, Offset: r.Offset, Value: r.Value})
	})
	return out, nil
}

// Commit commits the highest offset + 1 for each partition in the batch, synchronously.
func (k *KafkaConsumer) Commit(ctx context.Context, records []Record) error {
	if len(records) == 0 {
		return nil
	}
	offsets := map[string]map[int32]kgo.EpochOffset{}
	for _, r := range records {
		if offsets[r.Topic] == nil {
			offsets[r.Topic] = map[int32]kgo.EpochOffset{}
		}
		next := r.Offset + 1
		if cur, ok := offsets[r.Topic][r.Partition]; !ok || next > cur.Offset {
			offsets[r.Topic][r.Partition] = kgo.EpochOffset{Epoch: -1, Offset: next}
		}
	}
	// Epoch -1 means the record's leader epoch is not tracked here; Record carries no epoch.
	var commitErr error
	k.Client.CommitOffsetsSync(ctx, offsets, func(_ *kgo.Client, _ *kmsg.OffsetCommitRequest, _ *kmsg.OffsetCommitResponse, err error) {
		commitErr = err
	})
	return commitErr
}

// KafkaProducer adapts a producer client to the Producer interface. Delivery is synchronous.
type KafkaProducer struct {
	Client *kgo.Client
}

func (p *KafkaProducer) Produce(ctx context.Context, topic, key string, value []byte) error {
	return p.Client.ProduceSync(ctx, &kgo.Record{Topic: topic, Key: []byte(key), Value: value}).FirstErr()
}
