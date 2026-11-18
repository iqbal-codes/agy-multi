import { isPublicGeminiModel } from "../models";
import { isRecord } from "./guards";

function filterChoices(choices: unknown[]): unknown[] {
	return choices.flatMap(choice => {
		if (!isRecord(choice)) return [];
		if (Array.isArray(choice.options)) {
			const options = filterChoices(choice.options);
			return options.length ? [{ ...choice, options }] : [];
		}
		return isPublicGeminiModel(choice.value) ? [choice] : [];
	});
}

/** Filter the advertised choices while retaining the session's actual selected model. */
export function filterModelCatalog(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const models = value.models;
	const configOptions = value.configOptions;
	const hasModels = isRecord(models) && Array.isArray(models.availableModels);
	if (!hasModels && !Array.isArray(configOptions)) return value;
	return {
		...value,
		...(hasModels && Array.isArray(models.availableModels) ? {
			models: {
				...models,
				availableModels: models.availableModels.filter(model => isRecord(model) && isPublicGeminiModel(model.modelId)),
			},
		} : {}),
		...(Array.isArray(configOptions) ? {
			configOptions: configOptions.map(option =>
				isRecord(option) && (option.id === "model" || option.category === "model") && Array.isArray(option.options)
					? { ...option, options: filterChoices(option.options) }
					: option,
			),
		} : {}),
	};
}
