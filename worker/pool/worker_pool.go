package pool

import (
	"context"
	"log"
	"sync"

	"taskfire/worker/processor"
	"taskfire/worker/queue"
)

type WorkerPool struct {
	size      int
	queue     queue.Queue
	wg        sync.WaitGroup
	processor *processor.JobProcessor
}

func NewWorkerPool(size int, q queue.Queue) *WorkerPool {
	return &WorkerPool{
		size:      size,
		queue:     q,
		processor: processor.NewJobProcessor(),
	}
}

func (wp *WorkerPool) Start(ctx context.Context) {
	log.Printf("Starting worker pool with %d workers", wp.size)
	for i := 0; i < wp.size; i++ {
		wp.wg.Add(1)
		go wp.runWorker(ctx, i)
	}
}

func (wp *WorkerPool) Wait() {
	wp.wg.Wait()
}

func (wp *WorkerPool) runWorker(ctx context.Context, id int) {
	defer wp.wg.Done()
	log.Printf("Worker %d started", id)

	for {
		select {
		case <-ctx.Done():
			log.Printf("Worker %d stopping", id)
			return
		default:
			job, err := wp.queue.Dequeue(ctx, "default")
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				continue
			}
			if job == nil {
				continue
			}

			log.Printf("Worker %d processing job %s (type: %s)", id, job.ID, job.Type)
			if err := wp.processor.Process(ctx, job); err != nil {
				log.Printf("Worker %d failed job %s: %v", id, job.ID, err)
				wp.queue.Nack(ctx, job, err)
			} else {
				wp.queue.Ack(ctx, job)
			}
		}
	}
}
