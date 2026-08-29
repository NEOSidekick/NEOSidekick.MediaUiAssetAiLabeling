<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Tests\Unit\Eel;

use NEOSidekick\MediaUiAssetAiLabeling\Eel\AiClassificationHelper;
use Neos\Flow\Tests\UnitTestCase;
use Neos\Media\Domain\Model\Asset;
use Neos\Media\Domain\Model\AssetVariantInterface;
use Neos\Media\Domain\Model\Tag;

final class AiClassificationHelperTest extends UnitTestCase
{
    /** @test */
    public function itReturnsTheSupportedClassificationTag(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([
            new Tag('Unrelated'),
            new Tag('AI-modified'),
        ]);

        self::assertSame('AI-modified', (new AiClassificationHelper())->fromAsset($asset));
    }

    /** @test */
    public function generatedTakesPrecedenceOverModified(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([
            new Tag('AI-modified'),
            new Tag('AI-generated'),
        ]);

        self::assertSame('AI-generated', (new AiClassificationHelper())->fromAsset($asset));
    }

    /** @test */
    public function variantsInheritTheOriginalAssetClassification(): void
    {
        $originalAsset = $this->createMock(Asset::class);
        $originalAsset->method('getTags')->willReturn([new Tag('AI-generated')]);
        $variant = $this->createMock(AssetVariantInterface::class);
        $variant->method('getOriginalAsset')->willReturn($originalAsset);

        self::assertSame('AI-generated', (new AiClassificationHelper())->fromAsset($variant));
    }

    /** @test */
    public function itReturnsNullForUnclassifiedOrUnsupportedValues(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([new Tag('Unrelated')]);
        $helper = new AiClassificationHelper();

        self::assertNull($helper->fromAsset($asset));
        self::assertNull($helper->fromAsset(null));
    }

    /** @test */
    public function itReturnsTheHighestPriorityClassificationFromMultipleAssets(): void
    {
        $modifiedAsset = $this->createMock(Asset::class);
        $modifiedAsset->method('getTags')->willReturn([new Tag('AI-modified')]);
        $generatedAsset = $this->createMock(Asset::class);
        $generatedAsset->method('getTags')->willReturn([new Tag('AI-generated')]);

        self::assertSame(
            'AI-generated',
            (new AiClassificationHelper())->fromAssets([$modifiedAsset, $generatedAsset])
        );
    }

    /** @test */
    public function fromAssetsAlsoAcceptsASingleAssetOrNull(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([new Tag('AI-modified')]);
        $helper = new AiClassificationHelper();

        self::assertSame('AI-modified', $helper->fromAssets($asset));
        self::assertNull($helper->fromAssets(null));
    }

    /** @test */
    public function onlyTheDocumentedHelperMethodsAreExposedToEel(): void
    {
        $helper = new AiClassificationHelper();

        self::assertTrue($helper->allowsCallOfMethod('fromAsset'));
        self::assertTrue($helper->allowsCallOfMethod('fromAssets'));
        self::assertTrue($helper->allowsCallOfMethod('schemaOrgDigitalSourceType'));
        self::assertFalse($helper->allowsCallOfMethod('unknownMethod'));
    }

    /** @test */
    public function itMapsClassificationsToSchemaOrgDigitalSourceTypes(): void
    {
        $helper = new AiClassificationHelper();

        self::assertSame(
            'https://schema.org/TrainedAlgorithmicMediaDigitalSource',
            $helper->schemaOrgDigitalSourceType('AI-generated')
        );
        self::assertSame(
            'https://schema.org/CompositeWithTrainedAlgorithmicMediaDigitalSource',
            $helper->schemaOrgDigitalSourceType('AI-modified')
        );
        self::assertNull($helper->schemaOrgDigitalSourceType(null));
        self::assertNull($helper->schemaOrgDigitalSourceType('unsupported'));
    }

    /** @test */
    public function itMapsAssetsAndAssetCollectionsToSchemaOrgDigitalSourceTypes(): void
    {
        $modifiedAsset = $this->createMock(Asset::class);
        $modifiedAsset->method('getTags')->willReturn([new Tag('AI-modified')]);
        $generatedAsset = $this->createMock(Asset::class);
        $generatedAsset->method('getTags')->willReturn([new Tag('AI-generated')]);
        $helper = new AiClassificationHelper();

        self::assertSame(
            'https://schema.org/CompositeWithTrainedAlgorithmicMediaDigitalSource',
            $helper->schemaOrgDigitalSourceType($modifiedAsset)
        );
        self::assertSame(
            'https://schema.org/TrainedAlgorithmicMediaDigitalSource',
            $helper->schemaOrgDigitalSourceType([$modifiedAsset, $generatedAsset])
        );
    }
}
