import type { Quiz } from "../ai/schemas";

/**
 * One pre-written sample per Quick Notes format, derived from the prototype's neural-networks
 * SAMPLE text. Served with the demo banner when the ladder falls through or the user is out of
 * quota (docs/04 §2). Static — they cost nothing and never fail. Markdown formats are strings;
 * quiz formats are `Quiz` objects, matching real generated output.
 */

const KEY_POINTS = `**Structure**
- A network has an input layer, one or more hidden layers, and an output layer.
- Each connection has a weight; each neuron computes a weighted sum then a nonlinear activation.
- Nonlinear activations let the network represent complex, nonlinear relationships.

**Training**
- A loss function measures how far predictions fall from the targets; training minimises it.
- Backpropagation uses the chain rule to find each weight's contribution to the error.
- Gradient descent nudges each weight a small step in the direction that reduces the loss.
- The learning rate sets step size: too large is unstable, too small converges slowly.`;

const MAIN_CONCEPTS = `- **Neural network** — layers of weighted sums plus nonlinear activations that learn from data.
- **Weight** — the strength of a connection, adjusted during training.
- **Activation function** — a nonlinearity that gives the network expressive power.
- **Loss function** — a measure of prediction error to be minimised.
- **Backpropagation** — the chain-rule algorithm that computes gradients.
- **Gradient descent** — the optimiser that updates weights to reduce loss.
- **Learning rate** — the step size of each weight update.`;

const EXAM_POINTS = `- Neurons compute a weighted sum followed by a nonlinear activation.
- Training minimises a loss function that measures prediction error.
- Backpropagation applies the chain rule backward from output to input.
- Gradient descent steps weights along the negative gradient.
- The learning rate trades stability against speed of convergence.

## Likely questions
- What does a nonlinear activation add? — It lets stacked layers model nonlinear functions.
- What does backpropagation compute? — The gradient of the loss w.r.t. every weight.
- Why can the learning rate matter? — Too large diverges; too small trains slowly.`;

const SHORT_NOTES = `## Neural networks
- Layers: input → hidden(s) → output; each connection weighted.
- Neuron = weighted sum + nonlinear activation.

## Training
- Minimise a loss (prediction error).
- Backprop = chain rule, output → input.
- Gradient descent updates weights; learning rate = step size.`;

const FORMULAS_TERMS = `- **Weighted sum** — Σ(wᵢ·xᵢ) + b, computed by each neuron before activation.
- **Activation function** — a nonlinearity (e.g. ReLU, sigmoid) applied to the weighted sum.
- **Loss function** — quantifies the gap between predictions and targets.
- **Gradient** — the vector of partial derivatives of the loss w.r.t. the weights.
- **Learning rate (η)** — scales each gradient-descent step.`;

const SUMMARY = `Neural networks learn by adjusting connection weights until their outputs match the desired targets. Organised into input, hidden, and output layers, each neuron computes a weighted sum followed by a nonlinear activation, which lets the network represent complex relationships.

Training minimises a loss function that measures prediction error. Backpropagation applies the chain rule to compute how each weight contributed to the error, and gradient descent then updates every weight a small step in the direction that reduces the loss — repeated over many examples, and paced by the learning rate.`;

const MCQS: Quiz = {
  questions: [
    { q: "What does a nonlinear activation function let a network do?", options: ["Model nonlinear relationships", "Skip the loss function", "Avoid training", "Remove all weights"], answer: 0, explanation: "Without nonlinearity, stacked linear layers collapse into a single linear map." },
    { q: "What does the loss function measure?", options: ["The number of layers", "How far predictions fall from the targets", "The learning rate", "The batch size"], answer: 1, explanation: "Training minimises this measure of prediction error." },
    { q: "Backpropagation is essentially an application of the…", options: ["Chain rule of calculus", "Matrix inverse", "Softmax", "Random search"], answer: 0, explanation: "It propagates gradients backward using the chain rule." },
    { q: "Gradient descent moves each weight in the direction of the…", options: ["Positive gradient", "Negative gradient", "Largest weight", "Random noise"], answer: 1, explanation: "The negative gradient points toward lower loss." },
    { q: "A learning rate that is too large tends to…", options: ["Converge instantly", "Overshoot and diverge", "Remove hidden layers", "Increase accuracy guaranteed"], answer: 1, explanation: "Large steps overshoot the minimum, so the loss oscillates or diverges." },
  ],
};

const QUICK_TEST: Quiz = {
  questions: [
    { q: "Each neuron computes a weighted sum followed by a…", options: ["Nonlinear activation", "Matrix inverse", "Sorting step", "Random shuffle"], answer: 0, explanation: "The activation adds the nonlinearity that gives the network its power." },
    { q: "Training a network aims to…", options: ["Maximise the loss", "Minimise the loss", "Fix the weights", "Count the layers"], answer: 1, explanation: "The optimiser searches for weights that make the loss as small as possible." },
    { q: "Backpropagation flows error signals…", options: ["Output → input", "Input → output only", "Randomly", "Not at all"], answer: 0, explanation: "Gradients propagate backward from the output layer to the input layer." },
    { q: "The learning rate controls the…", options: ["Size of each weight update", "Number of neurons", "Dataset size", "Activation type"], answer: 0, explanation: "It is the step size of each gradient-descent update." },
  ],
};

/** Sample output keyed by format id. Markdown formats → string; quiz formats → Quiz. */
export const DEMO_NOTES: Record<string, string | Quiz> = {
  key_points: KEY_POINTS,
  main_concepts: MAIN_CONCEPTS,
  exam_points: EXAM_POINTS,
  short_notes: SHORT_NOTES,
  formulas_terms: FORMULAS_TERMS,
  summary: SUMMARY,
  mcqs: MCQS,
  quick_test: QUICK_TEST,
};
