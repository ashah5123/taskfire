package dag

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── kahnSort ────────────────────────────────────────────────────────────────

func TestKahnSort_EmptyGraph(t *testing.T) {
	order, err := kahnSort(depGraph{})
	require.NoError(t, err)
	assert.Empty(t, order)
}

func TestKahnSort_SingleNode(t *testing.T) {
	g := depGraph{"a": {}}
	order, err := kahnSort(g)
	require.NoError(t, err)
	assert.Equal(t, []string{"a"}, order)
}

func TestKahnSort_LinearChain(t *testing.T) {
	// c depends on b, b depends on a → order must be [a, b, c]
	g := depGraph{
		"a": {},
		"b": {"a"},
		"c": {"b"},
	}
	order, err := kahnSort(g)
	require.NoError(t, err)
	require.Len(t, order, 3)

	// a must come before b, b must come before c
	pos := make(map[string]int, len(order))
	for i, n := range order {
		pos[n] = i
	}
	assert.Less(t, pos["a"], pos["b"])
	assert.Less(t, pos["b"], pos["c"])
}

func TestKahnSort_Diamond(t *testing.T) {
	// d depends on b and c; both depend on a.
	//     a
	//    / \
	//   b   c
	//    \ /
	//     d
	g := depGraph{
		"a": {},
		"b": {"a"},
		"c": {"a"},
		"d": {"b", "c"},
	}
	order, err := kahnSort(g)
	require.NoError(t, err)
	require.Len(t, order, 4)

	pos := make(map[string]int, len(order))
	for i, n := range order {
		pos[n] = i
	}
	assert.Less(t, pos["a"], pos["b"])
	assert.Less(t, pos["a"], pos["c"])
	assert.Less(t, pos["b"], pos["d"])
	assert.Less(t, pos["c"], pos["d"])
}

func TestKahnSort_SimpleCycle(t *testing.T) {
	// a → b → a is a cycle.
	g := depGraph{
		"a": {"b"},
		"b": {"a"},
	}
	_, err := kahnSort(g)
	assert.ErrorIs(t, err, ErrCyclicDependency)
}

func TestKahnSort_LongerCycle(t *testing.T) {
	// a → b → c → a
	g := depGraph{
		"a": {"c"},
		"b": {"a"},
		"c": {"b"},
	}
	_, err := kahnSort(g)
	assert.ErrorIs(t, err, ErrCyclicDependency)
}

func TestKahnSort_SelfLoop(t *testing.T) {
	g := depGraph{
		"a": {"a"},
	}
	_, err := kahnSort(g)
	assert.ErrorIs(t, err, ErrCyclicDependency)
}

func TestKahnSort_CycleInSubgraph(t *testing.T) {
	// x is standalone; y and z form a cycle.
	g := depGraph{
		"x": {},
		"y": {"z"},
		"z": {"y"},
	}
	_, err := kahnSort(g)
	assert.ErrorIs(t, err, ErrCyclicDependency)
}

func TestKahnSort_ImpliedNodes(t *testing.T) {
	// "b" is referenced as a dependency but has no own entry in the graph.
	// The algorithm should still handle it correctly.
	g := depGraph{
		"a": {"b"},
	}
	order, err := kahnSort(g)
	require.NoError(t, err)
	require.Len(t, order, 2)

	pos := make(map[string]int)
	for i, n := range order {
		pos[n] = i
	}
	assert.Less(t, pos["b"], pos["a"])
}

// ── unique ──────────────────────────────────────────────────────────────────

func TestUnique_Empty(t *testing.T) {
	assert.Empty(t, unique(nil))
	assert.Empty(t, unique([]string{}))
}

func TestUnique_NoDuplicates(t *testing.T) {
	in := []string{"a", "b", "c"}
	out := unique(in)
	assert.Equal(t, []string{"a", "b", "c"}, out)
}

func TestUnique_WithDuplicates(t *testing.T) {
	in := []string{"a", "b", "a", "c", "b"}
	out := unique(in)
	assert.Equal(t, []string{"a", "b", "c"}, out)
}

func TestUnique_AllSame(t *testing.T) {
	in := []string{"x", "x", "x"}
	out := unique(in)
	assert.Equal(t, []string{"x"}, out)
}

func TestUnique_PreservesOrder(t *testing.T) {
	in := []string{"c", "a", "b", "a", "c"}
	out := unique(in)
	assert.Equal(t, []string{"c", "a", "b"}, out)
}
