/**
 * The curated machine-learning knowledge graph, lifted verbatim from the prototype
 * (docs/reference/edgify-prototype.html `CURATED`). Served in demo mode and when the ladder
 * falls through for a graph request (docs/04 §2). Static data — costs nothing at runtime and
 * never fails.
 */

export type DemoFlashcard = { front: string; back: string };
export type DemoQuiz = {
  q: string;
  options: string[];
  answer: number;
  explanation: string;
};
export type DemoConcept = {
  slug: string;
  name: string;
  difficulty: "Foundational" | "Intermediate" | "Advanced";
  summary: string;
  estimatedMinutes: number;
  layoutX: number;
  layoutY: number;
  prerequisites: string[];
  related: string[];
  definition: string;
  example: string;
  quiz: DemoQuiz;
  flashcards: DemoFlashcard[];
};

export type DemoGraph = {
  title: string;
  concepts: DemoConcept[];
  edges: { prerequisite: string; dependent: string }[];
};

const CONCEPTS: DemoConcept[] = [
  { slug: "calc", name: "Calculus", difficulty: "Foundational", estimatedMinutes: 180, layoutX: 24, layoutY: 520, prerequisites: [], related: ["linalg", "opt"],
    summary: "The study of continuous change through derivatives and integrals — the source of the gradients that drive training.",
    definition: "The study of continuous change through derivatives and integrals. In machine learning it supplies the gradients that tell an optimiser how each parameter affects the loss, making it the mathematical foundation of all gradient-based training.",
    example: "The derivative of the loss with respect to a weight tells you which direction — and how sharply — to nudge that weight to reduce error.",
    quiz: { q: "In training a model, the derivative of the loss with respect to a parameter tells you…", options: ["The final value of the parameter", "How changing the parameter changes the loss", "The number of layers in the model", "The size of the dataset"], answer: 1, explanation: "A derivative is a sensitivity: it measures how a small change in the parameter changes the loss — exactly what gradient descent needs." },
    flashcards: [{ front: "What is a partial derivative?", back: "The rate of change of a multivariable function with respect to one variable, holding the others fixed — the building block of a gradient." }, { front: "Why does deep learning need calculus?", back: "Training minimises a loss by following its gradient, and gradients are derivatives, so every weight update is an application of calculus." }] },
  { slug: "linalg", name: "Linear algebra", difficulty: "Foundational", estimatedMinutes: 200, layoutX: 310, layoutY: 520, prerequisites: [], related: ["calc", "nn"],
    summary: "The mathematics of vectors and matrices — the language in which every network layer transforms data.",
    definition: "The mathematics of vectors, matrices, and the linear transformations between them. Every layer of a neural network is fundamentally a matrix multiplication, so linear algebra is the language in which models represent and transform data.",
    example: "Multiplying an input vector by a weight matrix projects the data into a new feature space — a single dense layer expressed in one operation.",
    quiz: { q: "Applying a weight matrix to an input vector performs a…", options: ["Sorting operation", "Linear transformation of the input", "Random permutation", "Probability normalisation"], answer: 1, explanation: "A matrix defines a linear map; multiplying a vector by it transforms that vector into a new space — the core computation of a dense layer." },
    flashcards: [{ front: "What does the dot product measure?", back: "How aligned two vectors are; it underlies similarity, projections, and every neuron's weighted sum." }, { front: "Why represent a layer as a matrix?", back: "It lets the whole layer's weighted sums be computed in one efficient, parallel matrix multiply." }] },
  { slug: "prob", name: "Probability", difficulty: "Foundational", estimatedMinutes: 160, layoutX: 596, layoutY: 520, prerequisites: [], related: ["attn"],
    summary: "The framework for quantifying uncertainty — behind cross-entropy, softmax, and model confidence.",
    definition: "The framework for quantifying uncertainty using distributions, expectation, and likelihood. It underpins loss functions such as cross-entropy, the softmax that turns scores into class probabilities, and the way a model expresses confidence.",
    example: "The softmax function converts a vector of raw scores (logits) into a valid probability distribution over classes that sums to one.",
    quiz: { q: "The outputs of a softmax layer are guaranteed to…", options: ["Sum to one and be non-negative", "Be whole numbers", "Include negative values", "Be unbounded above"], answer: 0, explanation: "Softmax exponentiates and normalises the logits, producing a proper probability distribution: each value lies in (0,1) and they sum to 1." },
    flashcards: [{ front: "What is cross-entropy loss?", back: "A measure of the distance between the predicted probability distribution and the true labels; minimising it makes predictions match the targets." }, { front: "What does 'expectation' mean?", back: "The long-run average of a random variable, weighting each outcome by its probability." }] },
  { slug: "opt", name: "Optimization", difficulty: "Intermediate", estimatedMinutes: 150, layoutX: 90, layoutY: 426, prerequisites: ["calc", "linalg"], related: ["gd"],
    summary: "Finding parameter values that minimise a loss — training framed as a search over a landscape.",
    definition: "The problem of finding parameter values that minimise a loss function. Training a model is an optimisation problem, and understanding its landscape — minima, saddle points, and curvature — explains why methods like gradient descent behave as they do.",
    example: "Minimising a convex loss surface is like rolling a ball to the bottom of a smooth bowl; deep-network losses are bumpier, with many local minima.",
    quiz: { q: "During training, the optimiser's objective is to…", options: ["Maximise the loss", "Minimise the loss function", "Hold the loss constant", "Maximise the parameter count"], answer: 1, explanation: "Training minimises a loss that quantifies prediction error; the optimiser searches parameter space for values that make it as small as possible." },
    flashcards: [{ front: "Convex vs non-convex optimisation?", back: "Convex problems have a single global minimum and are easy to solve; deep-net losses are non-convex, with many minima and saddle points." }, { front: "What is a saddle point?", back: "A point that is a minimum along some directions and a maximum along others; it can stall training by flattening the gradient." }] },
  { slug: "gd", name: "Gradient descent", difficulty: "Intermediate", estimatedMinutes: 120, layoutX: 90, layoutY: 332, prerequisites: ["opt", "calc"], related: ["bp"],
    summary: "Iteratively stepping parameters down the negative gradient — the workhorse that trains networks.",
    definition: "An iterative optimisation algorithm that repeatedly steps parameters in the direction of the negative gradient to reduce the loss. Its variants — stochastic, mini-batch, and momentum-based — are the workhorses that actually train modern neural networks.",
    example: "A learning rate that is too large makes each step overshoot the minimum, so the loss oscillates or diverges instead of settling.",
    quiz: { q: "Gradient descent updates each parameter by moving it in the direction of the…", options: ["Positive gradient", "Negative gradient", "Largest weight", "Random noise"], answer: 1, explanation: "The gradient points uphill toward increasing loss, so descent steps in the opposite (negative) direction to decrease it." },
    flashcards: [{ front: "What is the learning rate?", back: "The step size of each update; too high overshoots and diverges, too low trains slowly and can get stuck." }, { front: "Why 'stochastic' gradient descent?", back: "It estimates the gradient from a small random mini-batch each step, trading exactness for far faster, noisier updates." }] },
  { slug: "bp", name: "Backpropagation", difficulty: "Advanced", estimatedMinutes: 140, layoutX: 180, layoutY: 238, prerequisites: ["gd", "linalg"], related: ["nn"],
    summary: "Computing every weight's gradient by applying the chain rule backward through the network.",
    definition: "The algorithm that computes the gradient of the loss with respect to every weight by applying the chain rule backward through the network, layer by layer. It makes training deep networks tractable by reusing intermediate results instead of recomputing gradients from scratch.",
    example: "Error signals originate at the output layer and flow backward; each layer multiplies them by its local derivatives to update its own weights.",
    quiz: { q: "Backpropagation is essentially an efficient application of the…", options: ["Chain rule of calculus, applied backward", "Matrix inverse", "Softmax function", "Random search over weights"], answer: 0, explanation: "Backprop applies the chain rule from output to input, reusing each layer's cached values so the full gradient is computed in a single backward pass." },
    flashcards: [{ front: "What does backprop actually compute?", back: "The partial derivative of the loss with respect to every weight and bias in the network." }, { front: "Forward pass vs backward pass?", back: "The forward pass computes the prediction and loss; the backward pass propagates gradients back to update the weights." }] },
  { slug: "nn", name: "Neural networks", difficulty: "Advanced", estimatedMinutes: 160, layoutX: 310, layoutY: 144, prerequisites: ["linalg", "bp"], related: ["cnn", "rnn", "attn"],
    summary: "Layers of weighted sums and nonlinear activations that learn representations from data.",
    definition: "Models built from layers of weighted sums followed by nonlinear activation functions, trained to learn useful representations directly from data. Stacking many layers lets the network compose simple features into increasingly abstract ones — the essence of deep learning.",
    example: "A multilayer perceptron can classify handwritten digits by learning edge and stroke detectors in early layers and digit shapes in later ones.",
    quiz: { q: "What is the primary role of a nonlinear activation function?", options: ["To speed up matrix multiplication", "To let the network model nonlinear relationships", "To reduce the number of weights", "To normalise the input data"], answer: 1, explanation: "Without nonlinearity, stacked linear layers collapse into a single linear map; activations give the network power to represent complex, nonlinear functions." },
    flashcards: [{ front: "Why are nonlinear activations essential?", back: "They stop stacked layers collapsing into one linear layer, letting the network approximate complex functions." }, { front: "What is a hidden layer?", back: "An intermediate layer between input and output that learns internal feature representations of the data." }] },
  { slug: "cnn", name: "CNN", difficulty: "Advanced", estimatedMinutes: 150, layoutX: 70, layoutY: 50, prerequisites: ["nn", "bp"], related: ["nn"],
    summary: "Shared spatial filters that detect a pattern anywhere — the standard architecture for images.",
    definition: "A convolutional neural network shares small learnable filters across the spatial dimensions of its input, detecting the same pattern wherever it appears. This weight sharing gives translation invariance and far fewer parameters, making CNNs the standard architecture for images and grid-structured data.",
    example: "Early-layer filters typically learn to detect edges and textures, which deeper layers combine into object parts and whole objects.",
    quiz: { q: "Convolutional layers primarily exploit which property of image data?", options: ["Random weight initialisation", "Spatial locality and weight sharing", "Sequential ordering", "Full connectivity between all pixels"], answer: 1, explanation: "A convolution slides one small filter across the whole image, reusing the same weights to capture local patterns efficiently and invariantly to position." },
    flashcards: [{ front: "What is a convolution filter?", back: "A small patch of shared weights slid across the input to detect a local pattern (like an edge) everywhere it occurs." }, { front: "How does weight sharing help?", back: "It cuts the parameter count dramatically and makes detection translation-invariant across the image." }] },
  { slug: "rnn", name: "RNN", difficulty: "Advanced", estimatedMinutes: 150, layoutX: 300, layoutY: 50, prerequisites: ["nn"], related: ["attn"],
    summary: "Processes a sequence step by step, carrying a hidden state — a memory suited to language.",
    definition: "A recurrent neural network processes a sequence one element at a time, maintaining a hidden state that carries information from previous steps forward. This gives it a form of memory suited to language and time series, though long-range dependencies are hard to preserve.",
    example: "Reading a sentence word by word, the hidden state accumulates context so the meaning of a later word can depend on earlier ones.",
    quiz: { q: "The hidden state of an RNN functions as…", options: ["A fixed lookup table", "A memory of everything seen so far in the sequence", "A random seed", "The final output label"], answer: 1, explanation: "At each step the hidden state is updated from the previous state and the current input, acting as a running summary of the sequence so far." },
    flashcards: [{ front: "What limits vanilla RNNs on long sequences?", back: "Vanishing (and exploding) gradients cause early information to fade over many time steps." }, { front: "What problem do LSTMs and GRUs address?", back: "They add gating to preserve information over longer ranges, mitigating the vanishing-gradient problem." }] },
  { slug: "attn", name: "Attention", difficulty: "Advanced", estimatedMinutes: 170, layoutX: 560, layoutY: 50, prerequisites: ["nn", "prob"], related: ["rnn"],
    summary: "Each element weighs every other via query–key–value — the core of the transformer.",
    definition: "A mechanism that lets each element of a sequence directly weigh and draw from every other element using learned query–key–value interactions. By modelling relationships regardless of distance, attention overcomes the range limits of RNNs and forms the core of the transformer.",
    example: "The word 'it' in a sentence can learn to attend strongly to the noun it refers to, pulling in that context no matter how far back it appeared.",
    quiz: { q: "Attention weights are typically produced by applying a … to the compatibility scores.", options: ["Softmax", "Single fixed matrix", "Random draw", "Sorting step"], answer: 0, explanation: "Query–key scores are passed through a softmax to produce weights that sum to one, setting how much each value contributes to the output." },
    flashcards: [{ front: "What are query, key, and value?", back: "A query is matched against keys to produce attention weights, which then combine the corresponding values into the output." }, { front: "Why did attention largely replace recurrence?", back: "It relates any two positions directly and in parallel, capturing long-range dependencies that RNNs struggle with." }] },
];

/** Edges derived from each concept's prerequisites (prerequisite must precede dependent). */
const EDGES = CONCEPTS.flatMap((concept) =>
  concept.prerequisites.map((prerequisite) => ({
    prerequisite,
    dependent: concept.slug,
  })),
);

export const DEMO_GRAPH: DemoGraph = {
  title: "Machine learning",
  concepts: CONCEPTS,
  edges: EDGES,
};
