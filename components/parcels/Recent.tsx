import { useState, useEffect } from "react";
import { BigNumber } from "ethers";
import { gql, useQuery } from "@apollo/client";
import { Container } from "react-bootstrap";
import { Framework } from "@superfluid-finance/sdk-core";
import type { Point } from "@turf/turf";
import * as turf from "@turf/turf";
import { GeoWebContent } from "@geo-web/content";
import { Contracts } from "@geo-web/sdk/dist/contract/types";
import { PCOLicenseDiamondFactory } from "@geo-web/sdk/dist/contract/index";
import { MAX_LIST_SIZE, Parcel, ParcelsQuery } from "./ParcelList";
import ParcelTable from "./ParcelTable";
import { STATE } from "../Map";
import { getParcelContent } from "../../lib/utils";
import { SECONDS_IN_WEEK } from "../../lib/constants";

interface RecentProps {
  sfFramework: Framework;
  geoWebContent: GeoWebContent;
  registryContract: Contracts["registryDiamondContract"];
  setSelectedParcelId: React.Dispatch<React.SetStateAction<string>>;
  setInteractionState: React.Dispatch<React.SetStateAction<STATE>>;
  handleCloseModal: () => void;
  setParcelNavigationCenter: React.Dispatch<React.SetStateAction<Point | null>>;
  shouldRefetch: boolean;
  setShouldRefetch: React.Dispatch<React.SetStateAction<boolean>>;
}

const recentQuery = gql`
  query Recent($skip: Int) {
    geoWebParcels(
      first: 25
      orderBy: createdAtBlock
      orderDirection: desc
      skip: $skip
    ) {
      id
      createdAtBlock
      bboxN
      bboxS
      bboxE
      bboxW
      licenseOwner
      licenseDiamond
      currentBid {
        forSalePrice
        contributionRate
        timestamp
      }
      pendingBid {
        forSalePrice
        timestamp
        contributionRate
      }
    }
  }
`;

function Recent(props: RecentProps) {
  const {
    sfFramework,
    geoWebContent,
    registryContract,
    setSelectedParcelId,
    setInteractionState,
    handleCloseModal,
    setParcelNavigationCenter,
    shouldRefetch,
    setShouldRefetch,
  } = props;

  const [parcels, setParcels] = useState<Parcel[] | null>(null);

  const { data, refetch, networkStatus } = useQuery<ParcelsQuery>(
    recentQuery,
    {
      variables: {
        skip: 0 * MAX_LIST_SIZE,
      },
      notifyOnNetworkStatusChange: true,
    }
  );

  useEffect(() => {
    if (!data) {
      return;
    }

    if (data.geoWebParcels.length === 0) {
      setParcels([]);
      return;
    }

    let isMounted = true;

    const _parcels: Parcel[] = [];
    const promises = [];

    for (const parcel of data.geoWebParcels) {
      let status: string;
      let forSalePrice: BigNumber;

      const parcelId = parcel.id;
      const createdAtBlock = parcel.createdAtBlock;
      const licenseOwner = parcel.licenseOwner;
      const currentBid = parcel.currentBid;
      const pendingBid = parcel.pendingBid;
      const licenseDiamondAddress = parcel.licenseDiamond;
      const licenseDiamondContract = PCOLicenseDiamondFactory.connect(
        licenseDiamondAddress,
        sfFramework.settings.provider
      );

      if (!pendingBid || BigNumber.from(pendingBid.contributionRate).eq(0)) {
        status = "Valid";
        forSalePrice = BigNumber.from(currentBid.forSalePrice);
      } else if (BigNumber.from(pendingBid.contributionRate).gt(0)) {
        status = "Outstanding Bid";
        forSalePrice = BigNumber.from(pendingBid.forSalePrice);
      } else {
        continue;
      }

      const promiseChain = licenseDiamondContract
        .shouldBidPeriodEndEarly()
        .then((shouldBidPeriodEndEarly) => {
          if (pendingBid && BigNumber.from(pendingBid.contributionRate).gt(0)) {
            const deadline = Number(pendingBid.timestamp) + SECONDS_IN_WEEK;
            const isPastDeadline = deadline * 1000 <= Date.now();

            if (isPastDeadline || shouldBidPeriodEndEarly) {
              status = "Needs Transfer";
              forSalePrice = BigNumber.from(pendingBid.forSalePrice);
            }
          }
        })
        .then(() => licenseDiamondContract.isPayerBidActive())
        .then((isPayerBidActive) => {
          if (!isPayerBidActive) {
            status = "In Foreclosure";
          }
        })
        .then(() =>
          getParcelContent(
            registryContract.address.toLowerCase(),
            geoWebContent,
            parcelId,
            licenseOwner
          )
        )
        .then((parcelContent) => {
          const name =
            parcelContent && parcelContent.name
              ? parcelContent.name
              : `Parcel ${parcelId}`;

          const poly = turf.bboxPolygon([
            parcel.bboxW,
            parcel.bboxS,
            parcel.bboxE,
            parcel.bboxN,
          ]);
          const center = turf.center(poly);

          _parcels.push({
            parcelId: parcelId,
            createdAtBlock: createdAtBlock,
            status: status,
            name: name,
            price: forSalePrice,
            center: center.geometry,
          });
        });

      promises.push(promiseChain);
    }

    Promise.all(promises).then(() => {
      if (isMounted) {
        const sorted = sortParcels(_parcels);

        setParcels(sorted);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [data]);

  useEffect(() => {
    if (!shouldRefetch) {
      return;
    }

    refetch({
      skip: 0,
    });

    setShouldRefetch(false);
  }, [shouldRefetch]);

  const sortParcels = (parcels: Parcel[]): Parcel[] => {
    const sorted = [...parcels].sort((a, b) => {
      let result = 0;

      result = a.createdAtBlock > b.createdAtBlock ? -1 : 1;

      return result;
    });

    return sorted;
  };

  const handleAction = (parcel: Parcel): void => {
    handleCloseModal();
    setInteractionState(STATE.PARCEL_SELECTED);
    setSelectedParcelId(parcel.parcelId);
    setParcelNavigationCenter(parcel.center);
  };

  return (
    <Container>
      <ParcelTable
        parcels={parcels}
        networkStatus={networkStatus}
        handleAction={handleAction}
      />
    </Container>
  );
}

export default Recent;
