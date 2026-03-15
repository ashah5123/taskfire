package dag

import (
	"fmt"
)

// Graph represents a directed acyclic graph of job dependencies.
type Graph struct {
	nodes map[string][]string // node -> dependencies
}

func NewGraph() *Graph {
	return &Graph{nodes: make(map[string][]string)}
}

// AddNode registers a job with its dependencies.
func (g *Graph) AddNode(id string, deps []string) {
	g.nodes[id] = deps
}

// TopologicalSort returns job IDs in execution order.
// Returns an error if a cycle is detected.
func (g *Graph) TopologicalSort() ([]string, error) {
	inDegree := make(map[string]int)
	for id := range g.nodes {
		if _, ok := inDegree[id]; !ok {
			inDegree[id] = 0
		}
		for _, dep := range g.nodes[id] {
			inDegree[dep] = inDegree[dep] // ensure dep is in map
			inDegree[id]++
			_ = dep
		}
	}

	// Kahn's algorithm
	visited := make(map[string]int) // 0=unvisited,1=visiting,2=done
	result := []string{}
	var visit func(id string) error
	visit = func(id string) error {
		if visited[id] == 2 {
			return nil
		}
		if visited[id] == 1 {
			return fmt.Errorf("cycle detected at node %s", id)
		}
		visited[id] = 1
		for _, dep := range g.nodes[id] {
			if err := visit(dep); err != nil {
				return err
			}
		}
		visited[id] = 2
		result = append(result, id)
		return nil
	}

	for id := range g.nodes {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// CanRun returns true if all dependencies of the given job ID have completed.
func (g *Graph) CanRun(id string, completed map[string]bool) bool {
	for _, dep := range g.nodes[id] {
		if !completed[dep] {
			return false
		}
	}
	return true
}
