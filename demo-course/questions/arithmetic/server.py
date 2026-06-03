import random


def generate(data):
    rng = random.Random(data["variant_seed"])
    left = rng.randint(4, 18)
    right = rng.randint(5, 21)

    data["params"]["left"] = left
    data["params"]["right"] = right
    data["correct_answers"]["sum"] = left + right
