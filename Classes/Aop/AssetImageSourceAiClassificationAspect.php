<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Aop;

use Neos\Flow\Annotations as Flow;
use Neos\Flow\Aop\JoinPointInterface;

#[Flow\Aspect]
#[Flow\Introduce(
    pointcutExpression: "class(Sitegeist\\Kaleidoscope\\Domain\\AbstractImageSource)",
    traitName: "NEOSidekick\\MediaUiAssetAiLabeling\\Domain\\AiClassificationDetectionTrait"
)]
final class AssetImageSourceAiClassificationAspect
{
    #[Flow\Around("method(Sitegeist\\Kaleidoscope\\Domain\\AbstractImageSource->allowsCallOfMethod())")]
    public function allowAiClassificationMethod(JoinPointInterface $joinPoint): bool
    {
        if ($joinPoint->getMethodArgument('methodName') === 'aiClassification') {
            return true;
        }

        return $joinPoint->getAdviceChain()->proceed($joinPoint);
    }
}
