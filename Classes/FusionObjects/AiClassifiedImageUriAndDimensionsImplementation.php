<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\FusionObjects;

use NEOSidekick\MediaUiAssetAiLabeling\Eel\AiClassificationHelper;
use Neos\Flow\Annotations as Flow;
use Networkteam\Neos\Util\FusionObjects\ImageUriAndDimensionsImplementation;

final class AiClassifiedImageUriAndDimensionsImplementation extends ImageUriAndDimensionsImplementation
{
    /**
     * @Flow\Inject
     * @var AiClassificationHelper
     */
    protected $aiClassificationHelper;

    public function evaluate(): array
    {
        $imageData = parent::evaluate();
        $imageData['aiClassification'] = $this->aiClassificationHelper->fromAsset($this->getAsset());

        return $imageData;
    }
}
